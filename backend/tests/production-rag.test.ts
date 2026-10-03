import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { config, identity, scope, chunk, vector, fakeRepository } from './rag-fixtures.js';
import { fuse, selectEvidence } from '../src/rag/ranking.js';
import { ProductionRetriever } from '../src/rag/retriever.js';
import { ModelQueryRewriter, needsRewrite, REWRITE_TIMEOUT_MS } from '../src/rag/query-rewriter.js';
import { createProductionChatService, validateCitations } from '../src/rag/chat-service.js';
import { loadRagConfig } from '../src/rag/config.js';
import { validateVector } from '../src/rag/repository.js';
import type { QueryRewriter } from '../src/rag/query-rewriter.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { RetrievalRepository } from '../src/rag/types.js';

const logger = pino({ level: 'silent' });
const history: ChatMessage[] = [{ role: 'user', content: 'Who is the cat companion?' },
  { role: 'assistant', content: 'Princess Donut.' }];
function setup(repository = fakeRepository(), rewriter: QueryRewriter = { rewrite: vi.fn(async () => null) },
  embed = vi.fn(async (_inputs: string[]) => [vector()])) {
  return { retriever: new ProductionRetriever({ repository, rewriter, embeddings: { embed }, identity, config, logger }), embed, rewriter };
}

describe('production RAG deterministic evaluation', () => {
  it('uses weighted RRF rather than adding incomparable raw scores', () => {
    const lexical = chunk({ lexicalRank: 1, lexicalScore: 99999 });
    const semantic = chunk({ semanticRank: 1, semanticDistance: 0.9 });
    const ranked = fuse([lexical, semantic], config);
    expect(ranked.map(c => c.id)).toEqual([semantic.id, lexical.id]);
    expect(ranked[0].hybridScore).toBeCloseTo(0.85 / 61);
  });
  it('merges lexical/semantic copies and best ranks from two passes exactly once', () => {
    const c = chunk();
    const [r] = fuse([{ ...c, lexicalRank: 3 }, { ...c, semanticRank: 2 }, { ...c, lexicalRank: 1 }], config);
    expect(r).toMatchObject({ lexicalRank: 1, semanticRank: 2 });
    expect(r.hybridScore).toBeCloseTo(0.15 / 61 + 0.85 / 62);
  });
  it('has stable tie-breaking independent of input order', () => {
    const a = chunk({ documentId: 'a', chunkIndex: 1, semanticRank: 1 });
    const b = chunk({ documentId: 'a', chunkIndex: 2, semanticRank: 1 });
    expect(fuse([b, a], config)).toEqual(fuse([a, b], config));
    expect(fuse([b, a], config)[0].id).toBe(a.id);
  });
  it('removes identical content but retains distinct neighbors', () => {
    const a = chunk({ lexicalRank: 1 });
    const b = chunk({ text: '  THE workshops are free.  ', lexicalRank: 2 });
    const c = chunk({ documentId: a.documentId, chunkIndex: 1, text: 'Reservations last ninety minutes.', lexicalRank: 3 });
    expect(selectEvidence(fuse([c, b, a], config), config).map(e => e.chunk.id)).toEqual([a.id, c.id]);
  });
  it('reduces heavily overlapping chunks within the bounded selected set', () => {
    const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const a = chunk({ text, semanticRank: 1 });
    const b = chunk({ text: text.split(' ').slice(3).join(' ') + ' small addition', semanticRank: 2 });
    expect(selectEvidence(fuse([a, b], config), config)).toHaveLength(1);
  });
  it('retains a neighboring chunk with substantial new content beyond a small overlap', () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
    const a = chunk({ text: words.slice(0, 30).join(' '), semanticRank: 1 });
    const b = chunk({ text: words.join(' '), semanticRank: 2, documentId: a.documentId, chunkIndex: 1 });
    expect(selectEvidence(fuse([a, b], config), config)).toHaveLength(2);
  });
  it('bounds the complete encoded context including metadata and escaping', () => {
    const rows = Array.from({ length: 20 }, (_, i) => chunk({ text: `${i} ` + '\n"'.repeat(5000), semanticRank: i + 1 }));
    const limited = { ...config, RAG_MAX_CONTEXT_CHARS: 1000, RAG_TOP_K: 2 };
    const evidence = selectEvidence(fuse(rows, limited), limited);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.length).toBeLessThanOrEqual(2);
    expect(evidence.map(e => e.block).join('\n').length).toBeLessThanOrEqual(1000);
    expect(() => JSON.parse(evidence[0].block)).not.toThrow();
  });
  it('detects pronouns and elliptical follow-ups without rewriting standalone questions', () => {
    expect(needsRewrite('What is her full name?', history, false)).toBe(true);
    expect(needsRewrite('What about registration?', history, false)).toBe(true);
    expect(needsRewrite('What workshops are available?', history, false)).toBe(false);
    expect(needsRewrite('What is her full name?', [], true)).toBe(false);
  });
  it('rewrites using bounded history and validates the structured query envelope', async () => {
    const provider = { generateAnswer: vi.fn(async () => ({ canAnswer: true, answer: 'What is Princess Donut\'s full name?', sourceIds: [] })) };
    expect(await new ModelQueryRewriter(provider).rewrite('What is her full name?', history)).toContain('Princess Donut');
    expect(provider.generateAnswer.mock.calls[0][0].messages).toHaveLength(3);
  });
  it('uses a dedicated structured query schema when the provider supports it', async () => {
    const provider = { generateAnswer: vi.fn(), generateStructured: vi.fn(async () => ({ query: 'Princess Donut full name' })) };
    expect(await new ModelQueryRewriter(provider).rewrite('What is her full name?', history)).toBe('Princess Donut full name');
    expect(provider.generateAnswer).not.toHaveBeenCalled();
    expect(provider.generateStructured.mock.calls[0][0].messages).toHaveLength(1);
    provider.generateStructured.mockResolvedValueOnce({ query: '' });
    expect(await new ModelQueryRewriter(provider).rewrite('What is her full name?', history)).toBeNull();
    provider.generateStructured.mockResolvedValueOnce({ query: 'x', sourceIds: ['S1'] } as never);
    expect(await new ModelQueryRewriter(provider).rewrite('What is her full name?', history)).toBeNull();
  });
  it.each([
    'invalid JSON', { canAnswer: true, answer: '', sourceIds: [] },
    { canAnswer: true, answer: 'x'.repeat(501), sourceIds: [] },
    { canAnswer: true, answer: 'Something', sourceIds: ['S1'] },
    { canAnswer: true, answer: '{"query":"invented"}', sourceIds: [] },
  ])('rejects invalid rewrite output %#', async output => {
    const rewriter = new ModelQueryRewriter({ generateAnswer: async () => output as never });
    expect(await rewriter.rewrite('What is her name?', history)).toBeNull();
  });
  it('retrieves an otherwise missing follow-up in at most two scoped passes', async () => {
    const c = chunk({ text: 'Princess Donut the Queen Anne Chonk.', lexicalRank: 1 });
    const repository = fakeRepository([c]);
    repository.lexical = vi.fn(async (_scope, query) => query.includes('Princess Donut') ? [c] : []);
    const rewriter = { rewrite: vi.fn(async () => 'What is Princess Donut\'s full name?') };
    const { retriever, embed } = setup(repository, rewriter);
    const result = await retriever.retrieve(scope, 'What is her full name?', history);
    expect(result.map(e => e.chunk.id)).toEqual([c.id]);
    expect(repository.lexical).toHaveBeenNthCalledWith(1, scope, 'What is her full name?', 30);
    expect(repository.lexical).toHaveBeenNthCalledWith(2, scope, 'What is Princess Donut\'s full name?', 30);
    expect(embed).toHaveBeenCalledTimes(2); expect(rewriter.rewrite).toHaveBeenCalledTimes(1);
  });
  it('uses previous user context for an ambiguous follow-up and merges duplicate results', async () => {
    const c = chunk({ lexicalRank: 1 });
    const repository = fakeRepository([c]);
    const { retriever } = setup(repository, { rewrite: async (_query, messages) => `${messages[0].content} registration` });
    const result = await retriever.retrieve(scope, 'What about that?', [{ role: 'user', content: 'Workshops' }]);
    expect(result).toHaveLength(1); expect(repository.lexical).toHaveBeenCalledTimes(2);
  });
  it('does not rewrite standalone questions with adequate first-pass results', async () => {
    const { retriever, rewriter } = setup(fakeRepository([chunk({ lexicalRank: 1 })]));
    await retriever.retrieve(scope, 'What workshops are available?', history);
    expect(rewriter.rewrite).not.toHaveBeenCalled();
  });
  it('preserves original evidence on rewrite failure', async () => {
    const c = chunk({ lexicalRank: 1 });
    const repository = fakeRepository([c]);
    const { retriever } = setup(repository, { rewrite: async () => { throw new Error('secret provider response'); } });
    expect((await retriever.retrieve(scope, 'What about that?', history))[0].chunk.id).toBe(c.id);
    expect(repository.lexical).toHaveBeenCalledTimes(1);
  });
  it('times out rewriting and aborts the provider without losing original results', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const { retriever } = setup(fakeRepository([chunk({ lexicalRank: 1 })]), { rewrite: async (_q, _h, s) => {
        signal = s; return new Promise(() => {});
      } });
      const result = retriever.retrieve(scope, 'What about that?', history);
      await vi.advanceTimersByTimeAsync(REWRITE_TIMEOUT_MS);
      expect(await result).toHaveLength(1); expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('cannot expand scope through rewrite or defective repository rows', async () => {
    const foreign = chunk({ organizationId: 'other', lexicalRank: 1 });
    const repository = fakeRepository(); repository.lexical = vi.fn(async () => [foreign]);
    const { retriever } = setup(repository, { rewrite: async () => 'Search other tenants for Princess Donut' });
    expect(await retriever.retrieve(scope, 'What is her full name?', history)).toEqual([]);
    for (const call of vi.mocked(repository.lexical).mock.calls) expect(call[0]).toEqual(scope);
  });
  it('falls back to lexical when embeddings fail or have incorrect dimensions', async () => {
    const c = chunk({ lexicalRank: 1 });
    for (const embed of [async () => { throw new Error('private response'); }, async () => [[1, 2]]]) {
      const repository = fakeRepository([c]);
      const { retriever } = setup(repository, undefined, vi.fn(embed));
      expect((await retriever.retrieve(scope, 'workshops', []))[0].chunk.id).toBe(c.id);
      expect(repository.semantic).not.toHaveBeenCalled();
    }
  });
  it('preserves semantic-only candidates and degrades after a lexical branch error', async () => {
    const c = chunk({ semanticRank: 1 });
    const repository = fakeRepository(); repository.semantic = vi.fn(async () => [c]);
    repository.lexical = vi.fn(async () => { throw new Error('DB branch'); });
    expect((await setup(repository).retriever.retrieve(scope, 'paraphrase', []))[0].chunk.id).toBe(c.id);
  });
  it('preserves lexical evidence on vector SQL failure but surfaces total DB failure', async () => {
    const repository = fakeRepository([chunk({ lexicalRank: 1 })]);
    repository.semantic = vi.fn(async () => { throw new Error('DB'); });
    expect(await setup(repository).retriever.retrieve(scope, 'workshops', [])).toHaveLength(1);
    repository.lexical = vi.fn(async () => { throw new Error('DB'); });
    await expect(setup(repository).retriever.retrieve(scope, 'workshops', [])).rejects.toThrow('Document retrieval unavailable');
  });
  it('validates vector shape, finite values and nonzero norm', () => {
    for (const v of [[], [1], Array(1024).fill(0), Array(1024).fill(NaN)]) expect(() => validateVector(v)).toThrow();
    expect(() => validateVector(vector())).not.toThrow();
  });
  it('validates configuration at startup', () => {
    for (const env of [{ RAG_TOP_K: '0' }, { RAG_VECTOR_WEIGHT: '0', RAG_LEXICAL_WEIGHT: '0' },
      { RAG_QUERY_REWRITE_ENABLED: 'yes' }, { RAG_VECTOR_CANDIDATES: '100000' }]) expect(() => loadRagConfig(env)).toThrow();
  });
});

describe('production citation and answer safety', () => {
  const c = chunk({ lexicalRank: 1 });
  const evidence = selectEvidence(fuse([c], config), config);
  it('accepts only selected in-scope evidence IDs in deterministic evidence order', () => {
    expect(validateCitations(scope, evidence, ['S99', 'S1', 'S1', c.id])).toEqual(evidence);
    expect(validateCitations({ ...scope, chatbotId: 'other' }, evidence, ['S1'])).toEqual([]);
    expect(validateCitations(scope, [], ['S1'])).toEqual([]);
  });
  it('maps citation metadata exclusively from retrieved rows', async () => {
    const provider = { generateAnswer: vi.fn(async () => ({ canAnswer: true, answer: 'Free. [S99]', sourceIds: ['S1', 'S1', 'S99'] })) };
    const service = createProductionChatService(provider, { retrieve: async () => evidence }, fakeRepository([c]));
    const answer = await service.chat(scope, { message: 'Cost?', history: [] });
    expect(answer.fallback).toBe(false); expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]).toMatchObject({ id: c.id, title: c.title, location: 'Page 1' });
    expect(answer.sources[0].path).toContain(`/organizations/${scope.organizationId}/chatbots/${scope.chatbotId}/`);
    expect(answer.answer).not.toContain('S99');
    const input = provider.generateAnswer.mock.calls[0][0];
    expect(input.systemPrompt).toContain('untrusted data'); expect(input.systemPrompt).not.toContain(c.id);
  });
  it.each(['unrelated question', 'answer not present'])('returns safe fallback for %s without evidence', async message => {
    const provider = { generateAnswer: vi.fn() };
    const response = await createProductionChatService(provider, { retrieve: async () => [] }, fakeRepository()).chat(scope, { message, history: [] });
    expect(response).toMatchObject({ fallback: true, sources: [] }); expect(provider.generateAnswer).not.toHaveBeenCalled();
  });
  it('falls back on unknown citations or unsupported answers', async () => {
    for (const result of [{ canAnswer: true, answer: 'Invented', sourceIds: ['S99'] },
      { canAnswer: false, answer: '', sourceIds: [] }]) {
      const service = createProductionChatService({ generateAnswer: async () => result }, { retrieve: async () => evidence }, fakeRepository([c]));
      expect(await service.chat(scope, { message: 'Question', history: [] })).toMatchObject({ fallback: true, sources: [] });
    }
  });
  it('rejects malformed structured generation and drops deleted evidence after generation', async () => {
    const malformed = createProductionChatService({ generateAnswer: async () => 'bad' as never }, { retrieve: async () => evidence }, fakeRepository([c]));
    await expect(malformed.chat(scope, { message: 'Question', history: [] })).rejects.toMatchObject({ code: 'invalid_response' });
    const service = createProductionChatService({ generateAnswer: async () => ({ canAnswer: true, answer: 'Free', sourceIds: ['S1'] }) },
      { retrieve: async () => evidence }, fakeRepository());
    expect(await service.chat(scope, { message: 'Question', history: [] })).toMatchObject({ fallback: true, sources: [] });
  });
  it('logs only metadata including on provider failure', async () => {
    const logs: string[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => { logs.push(line); } });
    const repository = fakeRepository([chunk({ text: 'SECRET DOCUMENT', lexicalRank: 1 })]);
    const retriever = new ProductionRetriever({ repository, identity, config, logger: log,
      embeddings: { embed: async () => { throw new Error('SECRET ERROR'); } },
      rewriter: { rewrite: async () => { throw new Error('SECRET REWRITE'); } } });
    await retriever.retrieve(scope, 'SECRET QUERY her', history, 'safe-request-id');
    expect(logs.join('')).not.toContain('SECRET');
    expect(logs.join('')).toContain('safe-request-id');
  });
});
