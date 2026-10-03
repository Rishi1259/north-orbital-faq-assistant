import { z } from 'zod';

export const RagEnvironmentSchema = z.object({
  RAG_TOP_K: z.coerce.number().int().min(1).max(8).default(5),
  RAG_LEXICAL_CANDIDATES: z.coerce.number().int().min(1).max(100).default(30),
  RAG_VECTOR_CANDIDATES: z.coerce.number().int().min(1).max(100).default(30),
  RAG_VECTOR_WEIGHT: z.coerce.number().min(0).max(1).default(0.85),
  RAG_LEXICAL_WEIGHT: z.coerce.number().min(0).max(1).default(0.15),
  RAG_RRF_K: z.coerce.number().int().min(1).max(1000).default(60),
  RAG_MAX_CONTEXT_CHARS: z.coerce.number().int().min(1000).max(40000).default(12000),
  RAG_QUERY_REWRITE_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
});
export type RagConfig = z.infer<typeof RagEnvironmentSchema>;
export function validRagWeights(v: RagConfig): boolean {
  return v.RAG_VECTOR_WEIGHT + v.RAG_LEXICAL_WEIGHT > 0;
}
export function loadRagConfig(env: NodeJS.ProcessEnv = process.env): RagConfig {
  return RagEnvironmentSchema.refine(validRagWeights, 'At least one RAG weight must be positive.').parse(env);
}
