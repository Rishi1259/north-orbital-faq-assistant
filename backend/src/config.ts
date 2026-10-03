import { RagEnvironmentSchema, validRagWeights } from './rag/config.js';
import { z } from 'zod';

const EnvironmentSchema = z.object({
  ...RagEnvironmentSchema.shape,
  NODE_ENV: z
    .enum([
      'development',
      'test',
      'production',
    ])
    .default('development'),

  PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(3000),

  DATABASE_URL: z
    .string()
    .min(1),

  DATABASE_POOL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),

  DATABASE_CONNECTION_TIMEOUT_MS:
    z.coerce
      .number()
      .int()
      .positive()
      .default(5000),

  OBJECT_STORAGE_ENDPOINT: z.url().optional(),
  OBJECT_STORAGE_REGION: z.string().min(1).default('us-east-1'),
  OBJECT_STORAGE_BUCKET: z.string().min(3).default('north-orbital-documents'),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(1).optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().min(1).optional(),
  OBJECT_STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  OBJECT_STORAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).max(104857600).default(20971520),
  INGESTION_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  INGESTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  INGESTION_STALE_AFTER_MS: z.coerce.number().int().min(3000).default(300000),
  INGESTION_EMBEDDING_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  OLLAMA_BASE_URL: z.url().default('http://127.0.0.1:11434'),
  OLLAMA_EMBEDDING_MODEL: z.literal('qwen3-embedding:0.6b').default('qwen3-embedding:0.6b'),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  OCR_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  OCR_COMMAND: z.string().min(1).default('ocrmypdf'),
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),

  CORS_ORIGIN: z
    .string()
    .default(
      'http://localhost:4200',
    ),
}).refine(validRagWeights, 'At least one RAG weight must be positive.').refine(v => Boolean(v.OBJECT_STORAGE_ACCESS_KEY) === Boolean(v.OBJECT_STORAGE_SECRET_KEY), { message: 'Both object storage credential fields must be configured together.' });

export type Environment =
  z.infer<
    typeof EnvironmentSchema
  >;

export function loadEnvironment(
  env: NodeJS.ProcessEnv =
    process.env,
): Environment {
  return EnvironmentSchema.parse(
    env,
  );
}