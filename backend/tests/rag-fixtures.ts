import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { loadRagConfig } from '../src/rag/config.js';
import type { Candidate, EmbeddingIdentity, RetrievalRepository, TenantScope } from '../src/rag/types.js';

export const config = loadRagConfig({});
export const identity: EmbeddingIdentity = { provider: 'ollama', model: 'qwen3-embedding:0.6b', dimensions: 1024 };
export const scope = { organizationId: randomUUID(), chatbotId: randomUUID() };
export function vector(axis = 0): number[] { return Array.from({ length: 1024 }, (_, i) => i === axis ? 1 : 0); }
export function chunk(overrides: Partial<Candidate> = {}): Candidate {
  return { ...scope, id: randomUUID(), documentId: randomUUID(), title: 'Synthetic document', chunkIndex: 0,
    page: 1, section: null, text: 'The workshops are free.', ...overrides };
}
export function fakeRepository(rows: Candidate[] = []): RetrievalRepository {
  return { lexical: vi.fn(async (s: TenantScope) => rows.filter(r => r.organizationId === s.organizationId && r.chatbotId === s.chatbotId)),
    semantic: vi.fn(async () => []), getByIds: vi.fn(async (s: TenantScope, ids: string[]) =>
      rows.filter(r => ids.includes(r.id) && r.organizationId === s.organizationId && r.chatbotId === s.chatbotId)) };
}
