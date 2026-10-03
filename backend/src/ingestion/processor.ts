import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';
import { extractDocument } from '../documents/extract-document.js';
import { chunkDocument } from '../documents/chunker.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { storageKey, type ObjectStorage } from '../storage/object-storage.js';
import { IngestionError, LeaseLostError, safeProcessingError } from './errors.js';
import type { OcrProvider } from './ocr.js';
import { pdfTextQuality } from './quality.js';
import type { IngestionRepository } from './repository.js';
import { jobScope, type IngestionJob } from './types.js';
import { MIME_TYPES, validateUpload } from './upload-validation.js';

export interface ProcessorOptions {
  repository: Pick<IngestionRepository, 'get' | 'heartbeat' | 'complete' | 'fail'>;
  storage: ObjectStorage;
  embeddings: EmbeddingProvider;
  ocr?: OcrProvider;
  logger: Logger;
  model: string;
  concurrency: number;
  staleAfterMs: number;
  maxBytes: number;
  extract?: typeof extractDocument;
}
export async function processJob(job: IngestionJob, options: ProcessorOptions): Promise<void> {
  const { repository, storage, embeddings, logger } = options;
  const context = { jobId: job.id, documentId: job.document_id,
    organizationId: job.organization_id, chatbotId: job.chatbot_id, attempt: job.attempts };
  const started = Date.now();
  let directory: string | undefined;
  let stage: ConstructorParameters<typeof IngestionError>[0] = 'download';
  let leaseLost = false;
  let heartbeat: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = repository.heartbeat(job).then(owned => { if (!owned) leaseLost = true; })
      .catch(() => { leaseLost = true; }).finally(() => { heartbeat = undefined; });
  }, Math.max(500, Math.floor(options.staleAfterMs / 3)));
  const assertLease = () => { if (leaseLost) throw new LeaseLostError(); };
  logger.info(context, 'Document ingestion started.');
  try {
    const document = await repository.get(jobScope(job));
    if (!document) throw new LeaseLostError();
    const format = document.mime_type === MIME_TYPES.pdf ? 'pdf' : 'docx';
    const object = { ...jobScope(job), format } as const;
    if (document.storage_key !== storageKey(object)) throw new IngestionError('download');
    directory = await mkdtemp(path.join(tmpdir(), 'document-ingestion-'));
    const input = path.join(directory, `source.${format}`);
    await storage.get(object, input);
    const verified = await validateUpload(input, `source.${format}`, options.maxBytes);
    if (verified.checksum !== document.checksum_sha256 || verified.size !== Number(document.size_bytes)) throw new IngestionError('download');
    assertLease();
    stage = 'extraction';
    const extract = options.extract ?? extractDocument;
    let extracted = await extract(input, 'uploaded-document');
    let ocrUsed = false;
    if (format === 'pdf' && !pdfTextQuality(extracted).usable) {
      if (!options.ocr) throw new IngestionError('ocr_disabled');
      stage = 'ocr';
      assertLease();
      const output = path.join(directory, 'ocr.pdf');
      await options.ocr.process(input, output);
      extracted = await extract(output, 'uploaded-document');
      ocrUsed = true;
      if (!pdfTextQuality(extracted).usable) throw new IngestionError('quality');
    }
    assertLease();
    // Source IDs from the legacy extractor are filename based. Replace document identity
    // here; DB chunk identity is UUID based and ordering remains the existing chunker's order.
    const chunks = chunkDocument({ ...extracted, id: document.id });
    if (!chunks.length || chunks.length > 10000) throw new IngestionError('quality');
    stage = 'embedding';
    const vectors: number[][] = [];
    for (let start = 0; start < chunks.length; start += options.concurrency) {
      assertLease();
      // Drain the whole bounded batch on failure before releasing the job.
      const batch = await Promise.allSettled(chunks.slice(start, start + options.concurrency)
        .map(async chunk => {
          const values = await embeddings.embed([chunk.text]);
          if (values.length !== 1 || values[0].length !== 1024 || values[0].some(n => !Number.isFinite(n))) throw new IngestionError('embedding');
          return values[0];
        }));
      for (const value of batch) {
        if (value.status === 'rejected') throw new IngestionError('embedding');
        vectors.push(value.value);
      }
    }
    assertLease();
    stage = 'persistence';
    await repository.complete(job, { chunks, embeddings: vectors, provider: 'ollama', model: options.model,
      ocrUsed, pageCount: format === 'pdf' ? extracted.pageCount ?? pdfTextQuality(extracted).pages : null });
    logger.info({ ...context, chunkCount: chunks.length, ocrUsed, durationMs: Date.now() - started }, 'Document ingestion succeeded.');
  } catch (error) {
    if (error instanceof LeaseLostError || leaseLost) {
      logger.warn(context, 'Document ingestion lease lost.');
      return;
    }
    const safe = error instanceof IngestionError ? error : new IngestionError(stage);
    try { await repository.fail(job, safe); }
    catch (failure) {
      if (!(failure instanceof LeaseLostError)) logger.error(context, 'Could not record ingestion failure; stale recovery will retry.');
    }
    logger.warn({ ...context, reason: safeProcessingError(safe), durationMs: Date.now() - started }, 'Document ingestion attempt failed.');
  } finally {
    clearInterval(timer);
    await heartbeat;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {
      logger.warn(context, 'Ingestion temporary cleanup failed.');
    });
  }
}
