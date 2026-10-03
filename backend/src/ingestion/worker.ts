import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnvironment } from '../config.js';
import { createDatabasePool } from '../database/database.js';
import { OllamaEmbeddingProvider } from '../embeddings/ollama-embedding-provider.js';
import { logger } from '../logging/logger.js';
import { S3ObjectStorage } from '../storage/object-storage.js';
import { CommandOcrProvider } from './ocr.js';
import { processJob } from './processor.js';
import { IngestionRepository } from './repository.js';

async function main() {
  const config = loadEnvironment();
  const pool = createDatabasePool({ connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX, connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS });
  pool.on('error', () => logger.error('Worker database connection failed.'));
  const repository = new IngestionRepository(pool);
  const storage = new S3ObjectStorage(config);
  const embeddings = new OllamaEmbeddingProvider({ baseUrl: config.OLLAMA_BASE_URL,
    model: config.OLLAMA_EMBEDDING_MODEL, timeoutMs: config.EMBEDDING_TIMEOUT_MS });
  const ocr = config.OCR_ENABLED ? new CommandOcrProvider(config.OCR_COMMAND, config.OCR_TIMEOUT_MS) : undefined;
  const workerId = randomUUID();
  const shutdown = new AbortController();
  const stop = () => { shutdown.abort(); logger.info({ workerId }, 'Worker stopping after current job.'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  logger.info({ workerId }, 'Ingestion worker started.');
  try {
    while (!shutdown.signal.aborted) {
      try {
        const recovered = await repository.recoverStale(config.INGESTION_STALE_AFTER_MS);
        if (recovered) logger.info({ workerId, count: recovered }, 'Recovered stale ingestion jobs.');
        if (shutdown.signal.aborted) break;
        const job = await repository.claim(workerId);
        if (job) {
          await processJob(job, { repository, storage, embeddings, ocr, logger,
            model: config.OLLAMA_EMBEDDING_MODEL, concurrency: config.INGESTION_EMBEDDING_CONCURRENCY,
            staleAfterMs: config.INGESTION_STALE_AFTER_MS, maxBytes: config.UPLOAD_MAX_BYTES });
          continue;
        }
      } catch { logger.error({ workerId }, 'Ingestion queue polling failed.'); }
      await delay(config.INGESTION_POLL_INTERVAL_MS, undefined, { signal: shutdown.signal }).catch(() => {});
    }
  } finally {
    storage.close(); await pool.end();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}
main().catch(() => { logger.fatal('Ingestion worker startup failed. Check configuration and dependencies.'); process.exitCode = 1; });
