import type { ChatMessage } from '../ai/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { Logger } from 'pino';
import type { RagConfig } from './config.js';
import { fuse, selectEvidence } from './ranking.js';
import { needsRewrite, REWRITE_TIMEOUT_MS, validRewrite, type QueryRewriter } from './query-rewriter.js';
import { inScope, type Candidate, type EmbeddingIdentity, type RetrievalRepository, type TenantScope } from './types.js';
import { validateVector } from './repository.js';

export interface RetrieverOptions {
  repository: RetrievalRepository;
  embeddings: EmbeddingProvider;
  identity: EmbeddingIdentity;
  config: RagConfig;
  rewriter: QueryRewriter;
  logger: Logger;
}
export class ProductionRetriever {
  constructor(private readonly options: RetrieverOptions) {}
  async retrieve(scope: TenantScope, query: string, history: ChatMessage[], requestId?: string) {
    const started = Date.now();
    const { repository, embeddings, identity, config, rewriter, logger } = this.options;
    const metadata = { ...scope, requestId };
    let semanticFallbackUsed = false;
    const pass = async (search: string, retrievalPass: number): Promise<Candidate[]> => {
      const start = Date.now();
      const [lexical, semantic] = await Promise.allSettled([
        repository.lexical(scope, search, config.RAG_LEXICAL_CANDIDATES),
        (async () => {
          let vector: number[];
          try {
            const vectors = await embeddings.embed([search]);
            if (vectors.length !== 1) throw new Error('Invalid query embedding count.');
            vector = vectors[0]; validateVector(vector);
          } catch {
            semanticFallbackUsed = true;
            logger.warn({ ...metadata, retrievalPass, failure: 'query_embedding' }, 'Semantic retrieval unavailable.');
            return null;
          }
          return repository.semantic(scope, vector, identity, config.RAG_VECTOR_CANDIDATES);
        })(),
      ]);
      if (lexical.status === 'rejected') logger.warn({ ...metadata, retrievalPass, failure: 'lexical_search' }, 'Retrieval branch failed.');
      if (semantic.status === 'rejected') {
        semanticFallbackUsed = true;
        logger.warn({ ...metadata, retrievalPass, failure: 'semantic_search' }, 'Retrieval branch failed.');
      }
      // An unavailable DB is an API error, not an empty knowledge base.
      if (lexical.status === 'rejected' && (semantic.status === 'rejected' || semantic.value === null)) {
        throw new Error('Document retrieval unavailable.');
      }
      const lexicalRows = lexical.status === 'fulfilled' ? lexical.value : [];
      const semanticRows = semantic.status === 'fulfilled' ? semantic.value ?? [] : [];
      logger.info({ ...metadata, retrievalPass, lexicalCandidateCount: lexicalRows.length,
        semanticCandidateCount: semanticRows.length, durationMs: Date.now() - start }, 'RAG retrieval pass completed.');
      return [...lexicalRows, ...semanticRows].filter(c => inScope(scope, c));
    };
    // Pass one always receives the actual user query, unmodified by history or rewriting.
    const candidates = await pass(query, 1);
    let rewriteUsed = false;
    if (config.RAG_QUERY_REWRITE_ENABLED && needsRewrite(query, history, candidates.length === 0)) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const rewritten = await Promise.race([
          rewriter.rewrite(query, history, controller.signal),
          new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, REWRITE_TIMEOUT_MS); }),
        ]);
        if (validRewrite(rewritten) && rewritten.trim().toLowerCase() !== query.trim().toLowerCase()) {
          // Only one additional pass; history/rewrite never controls scope.
          candidates.push(...await pass(rewritten.trim(), 2)); rewriteUsed = true;
        } else logger.info({ ...metadata, failure: 'rewrite_unavailable_or_unchanged' }, 'Using original retrieval.');
      } catch {
        logger.warn({ ...metadata, failure: 'rewrite_or_second_pass' }, 'Using original retrieval.');
      } finally { clearTimeout(timer); }
    }
    const ranked = fuse(candidates, config);
    const evidence = selectEvidence(ranked, config);
    logger.info({ ...metadata, dedupedCandidateCount: ranked.length, selectedEvidenceCount: evidence.length,
      rewriteUsed, semanticFallbackUsed, durationMs: Date.now() - started }, 'RAG evidence selected.');
    return evidence;
  }
}
