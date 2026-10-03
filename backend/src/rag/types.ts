import type { TenantScope } from '../ingestion/types.js';
export type { TenantScope } from '../ingestion/types.js';

export interface EvidenceChunk extends TenantScope {
  id: string;
  documentId: string;
  title: string;
  chunkIndex: number;
  page: number | null;
  section: string | null;
  text: string;
}
export interface Candidate extends EvidenceChunk {
  lexicalRank?: number;
  lexicalScore?: number;
  semanticRank?: number;
  semanticDistance?: number;
}
export interface RankedCandidate extends Candidate { hybridScore: number }
export interface EmbeddingIdentity { provider: string; model: string; dimensions: 1024 }
export interface RetrievalRepository {
  lexical(scope: TenantScope, query: string, limit: number): Promise<Candidate[]>;
  semantic(scope: TenantScope, vector: number[], identity: EmbeddingIdentity, limit: number): Promise<Candidate[]>;
  getByIds(scope: TenantScope, ids: string[]): Promise<EvidenceChunk[]>;
}
export function inScope(scope: TenantScope, chunk: EvidenceChunk): boolean {
  return chunk.organizationId === scope.organizationId && chunk.chatbotId === scope.chatbotId;
}
