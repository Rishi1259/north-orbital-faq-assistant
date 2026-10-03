import type { Pool } from 'pg';
import type { Candidate, EmbeddingIdentity, EvidenceChunk, RetrievalRepository, TenantScope } from './types.js';

const columns = `c.id, c.organization_id AS "organizationId", c.chatbot_id AS "chatbotId",
  c.document_id AS "documentId", d.title, c.chunk_index AS "chunkIndex",
  c.page_number AS page, c.section, c.content AS text`;
const readyChunks = `FROM document_chunks c JOIN documents d
  ON d.id=c.document_id AND d.organization_id=c.organization_id AND d.chatbot_id=c.chatbot_id`;
const scopeFilter = `c.organization_id=$1 AND c.chatbot_id=$2
  AND d.organization_id=$1 AND d.chatbot_id=$2 AND d.status='ready'`;
const limitCandidates = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid retrieval limit.');
  return limit;
};
export function validateVector(vector: number[]): void {
  if (vector.length !== 1024 || vector.some(v => !Number.isFinite(v)) || !vector.some(v => v !== 0)) {
    throw new Error('Invalid query embedding.');
  }
}
export class PostgresRetrievalRepository implements RetrievalRepository {
  constructor(private readonly database: Pick<Pool, 'query'>) {}

  async lexical(scope: TenantScope, query: string, limit: number): Promise<Candidate[]> {
    const result = await this.database.query<Candidate>(`SELECT ${columns},
      ts_rank_cd(c.search_vector, q.query)::float8 AS "lexicalScore"
      ${readyChunks} CROSS JOIN (
        SELECT to_tsquery('simple'::regconfig, coalesce(string_agg(quote_literal(term), ' | '), '')) AS query
        FROM unnest(tsvector_to_array(to_tsvector('simple'::regconfig, $3))) term
        WHERE term <> ALL(ARRAY['a','an','the','is','are','was','were','be','been','to','of','in','on','at',
          'and','or','for','with','do','does','did','can','could','would','should','what','which','who','when',
          'where','how','why','i','you','he','she','it','we','they','my','your','his','her','its','their','me',
          'this','that','these','those','about'])
      ) q
      WHERE ${scopeFilter} AND numnode(q.query)>0 AND c.search_vector @@ q.query
      ORDER BY "lexicalScore" DESC, c.document_id, c.chunk_index, c.id LIMIT $4`,
    [scope.organizationId, scope.chatbotId, query.slice(0, 1000), limitCandidates(limit)]);
    return result.rows.map((row, index) => ({ ...row, lexicalRank: index + 1 }));
  }

  async semantic(scope: TenantScope, vector: number[], identity: EmbeddingIdentity, limit: number): Promise<Candidate[]> {
    validateVector(vector);
    if (identity.dimensions !== 1024) throw new Error('Invalid embedding dimensions.');
    // The distance operator matches the existing vector_cosine_ops HNSW index.
    // Materialize a bounded nearest-neighbor set; apply stable tie-breaking in SQL.
    const result = await this.database.query<Candidate>(`WITH nearest AS MATERIALIZED (
      SELECT ${columns}, (e.embedding <=> $3::vector(1024)) AS "semanticDistance"
      ${readyChunks} JOIN document_embeddings e ON e.chunk_id=c.id AND e.document_id=c.document_id
        AND e.organization_id=c.organization_id AND e.chatbot_id=c.chatbot_id
      WHERE ${scopeFilter} AND e.organization_id=$1 AND e.chatbot_id=$2
        AND e.provider=$4 AND e.model=$5 AND e.dimensions=$6
      ORDER BY e.embedding <=> $3::vector(1024), c.document_id, c.chunk_index, c.id LIMIT $7
    ) SELECT * FROM nearest ORDER BY "semanticDistance", "documentId", "chunkIndex", id`,
    [scope.organizationId, scope.chatbotId, JSON.stringify(vector), identity.provider, identity.model,
      identity.dimensions, limitCandidates(limit)]);
    return result.rows.filter(row => Number.isFinite(row.semanticDistance))
      .map((row, index) => ({ ...row, semanticRank: index + 1 }));
  }

  async getByIds(scope: TenantScope, ids: string[]): Promise<EvidenceChunk[]> {
    if (ids.length > 100) throw new Error('Too many source IDs.');
    if (!ids.length) return [];
    return (await this.database.query<EvidenceChunk>(`SELECT ${columns} ${readyChunks}
      WHERE ${scopeFilter} AND c.id=ANY($3::uuid[])
      ORDER BY c.document_id, c.chunk_index, c.id`, [scope.organizationId, scope.chatbotId, ids])).rows;
  }
}
