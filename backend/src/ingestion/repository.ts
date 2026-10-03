import type { Pool, PoolClient } from 'pg';
import { DocumentError, IngestionError, LeaseLostError, safeProcessingError } from './errors.js';
import { jobScope, type DocumentScope, type IngestionJob, type NewDocument,
  type ProcessingResult, type StoredDocument, type TenantScope } from './types.js';

const scopeWhere = 'organization_id = $1 AND chatbot_id = $2 AND id = $3';
const jobWhere = `organization_id = $1 AND chatbot_id = $2 AND document_id = $3
  AND id = $4 AND locked_by = $5 AND attempts = $6 AND status = 'processing'`;
function scopeValues(scope: DocumentScope) { return [scope.organizationId, scope.chatbotId, scope.documentId]; }
function leaseValues(job: IngestionJob) { return [...scopeValues(jobScope(job)), job.id, job.locked_by, job.attempts]; }
export function retryDelayMs(attempts: number): number {
  return Math.min(300_000, 1000 * 2 ** Math.max(0, Math.min(attempts - 1, 20)));
}
export function failureState(attempts: number, maxAttempts: number) {
  return attempts >= maxAttempts ? 'failed' as const : 'queued' as const;
}

export class IngestionRepository {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  private async enqueue(client: PoolClient, scope: DocumentScope, maxAttempts: number) {
    await client.query(`INSERT INTO document_ingestion_jobs
      (organization_id, chatbot_id, document_id, max_attempts) VALUES ($1, $2, $3, $4)`,
    [...scopeValues(scope), maxAttempts]);
  }
  async create(input: NewDocument): Promise<StoredDocument> {
    return this.transaction(async client => {
      const result = await client.query<StoredDocument>(`INSERT INTO documents
        (organization_id, chatbot_id, id, title, original_filename, mime_type, storage_key, checksum_sha256, size_bytes)
        VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8) RETURNING *`,
      [...scopeValues(input), input.filename, input.mimeType, input.storageKey, input.checksum, input.size]);
      await this.enqueue(client, input, input.maxAttempts);
      return result.rows[0];
    });
  }
  async get(scope: DocumentScope): Promise<StoredDocument | null> {
    return (await this.pool.query<StoredDocument>(`SELECT * FROM documents WHERE ${scopeWhere}`,
      scopeValues(scope))).rows[0] ?? null;
  }
  async list(scope: TenantScope, limit = 50, offset = 0): Promise<StoredDocument[]> {
    return (await this.pool.query<StoredDocument>(`SELECT * FROM documents
      WHERE organization_id = $1 AND chatbot_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
    [scope.organizationId, scope.chatbotId, limit, offset])).rows;
  }
  async retry(scope: DocumentScope, maxAttempts: number): Promise<StoredDocument> {
    return this.transaction(async client => {
      const doc = (await client.query<StoredDocument>(`SELECT * FROM documents WHERE ${scopeWhere} FOR UPDATE`, scopeValues(scope))).rows[0];
      if (!doc) throw new DocumentError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
      if (doc.status !== 'failed') throw new DocumentError(409, 'INVALID_DOCUMENT_STATE', 'Only failed documents can be retried.');
      const active = await client.query(`SELECT id FROM document_ingestion_jobs WHERE organization_id=$1
        AND chatbot_id=$2 AND document_id=$3 AND status IN ('queued','processing')`, scopeValues(scope));
      if (active.rowCount) throw new DocumentError(409, 'INVALID_DOCUMENT_STATE', 'Document processing is already queued.');
      await this.enqueue(client, scope, maxAttempts);
      return (await client.query<StoredDocument>(`UPDATE documents SET status='pending', error_message=NULL,
        processed_at=NULL, ocr_used=false, page_count=NULL, chunk_count=NULL, updated_at=now()
        WHERE ${scopeWhere} RETURNING *`, scopeValues(scope))).rows[0];
    });
  }
  async claim(workerId: string): Promise<IngestionJob | null> {
    return this.transaction(async client => {
      const job = (await client.query<IngestionJob>(`WITH candidate AS (
        SELECT id FROM document_ingestion_jobs WHERE status='queued' AND available_at<=now()
          AND attempts<max_attempts ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE document_ingestion_jobs j SET status='processing', attempts=attempts+1,
          locked_at=now(), locked_by=$1, updated_at=now() FROM candidate c WHERE j.id=c.id RETURNING j.*`,
      [workerId])).rows[0];
      if (!job) return null;
      await client.query(`UPDATE documents SET status='processing', error_message=NULL, updated_at=now()
        WHERE ${scopeWhere}`, scopeValues(jobScope(job)));
      return job;
    });
  }
  async heartbeat(job: IngestionJob): Promise<boolean> {
    const result = await this.pool.query(`UPDATE document_ingestion_jobs SET locked_at=now(), updated_at=now()
      WHERE ${jobWhere}`, leaseValues(job));
    return result.rowCount === 1;
  }
  private async assertLease(client: PoolClient, job: IngestionJob) {
    const result = await client.query(`SELECT id FROM document_ingestion_jobs WHERE ${jobWhere} FOR UPDATE`, leaseValues(job));
    if (!result.rowCount) throw new LeaseLostError();
  }
  private async recordFailure(client: PoolClient, job: IngestionJob, message: string) {
    const status = failureState(job.attempts, job.max_attempts);
    await client.query(`UPDATE document_ingestion_jobs SET status=$7, last_error=$8,
      available_at=now()+($9 * interval '1 millisecond'), locked_at=NULL, locked_by=NULL, updated_at=now(),
      completed_at=CASE WHEN $7='failed' THEN now() ELSE NULL END WHERE ${jobWhere}`,
    [...leaseValues(job), status, message, retryDelayMs(job.attempts)]);
    await client.query(`UPDATE documents SET status=$4, error_message=$5, updated_at=now()
      WHERE ${scopeWhere}`, [...scopeValues(jobScope(job)), status === 'failed' ? 'failed' : 'pending', message]);
  }
  async fail(job: IngestionJob, error: unknown) {
    await this.transaction(async client => {
      await this.assertLease(client, job);
      await this.recordFailure(client, job, safeProcessingError(error));
    });
  }
  async recoverStale(staleAfterMs: number): Promise<number> {
    return this.transaction(async client => {
      const jobs = await client.query<IngestionJob>(`SELECT * FROM document_ingestion_jobs
        WHERE status='processing' AND locked_at < now()-($1 * interval '1 millisecond')
        ORDER BY locked_at FOR UPDATE SKIP LOCKED LIMIT 100`, [staleAfterMs]);
      for (const job of jobs.rows) await this.recordFailure(client, job, safeProcessingError(new IngestionError('stale')));
      return jobs.rows.length;
    });
  }
  async complete(job: IngestionJob, result: ProcessingResult) {
    if (!result.chunks.length || result.chunks.length !== result.embeddings.length ||
      result.embeddings.some(v => v.length !== 1024 || v.some(n => !Number.isFinite(n)))) {
      throw new IngestionError('embedding');
    }
    await this.transaction(async client => {
      await this.assertLease(client, job);
      const scope = scopeValues(jobScope(job));
      await client.query(`DELETE FROM document_chunks WHERE organization_id=$1 AND chatbot_id=$2 AND document_id=$3`, scope);
      for (const [index, chunk] of result.chunks.entries()) {
        const inserted = await client.query<{id: string}>(`INSERT INTO document_chunks
          (organization_id, chatbot_id, document_id, chunk_index, block_id, content, page_number, section)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [...scope, index, chunk.blockId, chunk.text, chunk.page ?? null, chunk.section ?? null]);
        await client.query(`INSERT INTO document_embeddings
          (organization_id, chatbot_id, document_id, chunk_id, provider, model, dimensions, embedding)
          VALUES ($1,$2,$3,$4,$5,$6,1024,$7::vector)`,
        [...scope, inserted.rows[0].id, result.provider, result.model, JSON.stringify(result.embeddings[index])]);
      }
      await client.query(`UPDATE documents SET status='ready', error_message=NULL, processed_at=now(),
        ocr_used=$4, page_count=$5, chunk_count=$6, updated_at=now() WHERE ${scopeWhere}`,
      [...scope, result.ocrUsed, result.pageCount, result.chunks.length]);
      await client.query(`UPDATE document_ingestion_jobs SET status='succeeded', completed_at=now(),
        last_error=NULL, locked_at=NULL, locked_by=NULL, updated_at=now() WHERE ${jobWhere}`, leaseValues(job));
    });
  }
}
