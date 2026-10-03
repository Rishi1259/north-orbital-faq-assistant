import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { IngestionRepository } from '../../src/ingestion/repository.js';
import { IngestionError, LeaseLostError } from '../../src/ingestion/errors.js';
import { jobScope, type NewDocument, type ProcessingResult } from '../../src/ingestion/types.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for database integration tests.');
// Isolate queue claims from any running development worker and all existing tenant data.
const schema = `ingestion_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public`, max: 8 });
const repository = new IngestionRepository(pool);
let input: NewDocument;
let otherOrg: string;
let otherBot: string;
const result: ProcessingResult = { chunks: [{ id: 'old-id', documentId: 'ignored', documentTitle: 'Synthetic test',
  fileName: 'test.pdf', sourcePath: 'test', format: 'pdf', blockId: 'page-1', text: 'Synthetic test content', page: 1 }],
  embeddings: [Array(1024).fill(0.1)], provider: 'ollama', model: 'qwen3-embedding:0.6b', ocrUsed: false, pageCount: 1 };

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runner({ databaseUrl: process.env.DATABASE_URL!, dir: fileURLToPath(new URL('../../migrations', import.meta.url)),
    direction: 'up', migrationsTable: 'pgmigrations', migrationsSchema: schema, schema: [schema, 'public'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } });
}, 30000);
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('DELETE FROM organizations');
  const orgs = (await pool.query("INSERT INTO organizations(name,slug) VALUES ('Test A','test-a'),('Test B','test-b') RETURNING id")).rows;
  const organizationId = orgs[0].id; otherOrg = orgs[1].id;
  const chatbotId = (await pool.query("INSERT INTO chatbots(organization_id,name) VALUES ($1,'Test bot') RETURNING id", [organizationId])).rows[0].id;
  otherBot = (await pool.query("INSERT INTO chatbots(organization_id,name) VALUES ($1,'Other bot') RETURNING id", [otherOrg])).rows[0].id;
  input = { organizationId, chatbotId, documentId: randomUUID(), filename: 'test.pdf', format: 'pdf', mimeType: 'application/pdf',
    storageKey: 'synthetic-test', checksum: 'a'.repeat(64), size: 10, maxAttempts: 3 };
});
it('creates document and job atomically and enforces tenant ownership and one active job', async () => {
  await repository.create(input);
  await expect(pool.query(`INSERT INTO document_ingestion_jobs(organization_id,chatbot_id,document_id)
    VALUES($1,$2,$3)`, [otherOrg, otherBot, input.documentId])).rejects.toMatchObject({ code: '23503' });
  await expect(pool.query(`INSERT INTO document_ingestion_jobs(organization_id,chatbot_id,document_id)
    VALUES($1,$2,$3)`, [input.organizationId, input.chatbotId, input.documentId])).rejects.toMatchObject({ code: '23505' });
  expect(await repository.get({ ...input, organizationId: otherOrg })).toBeNull();
  expect(await repository.list({ organizationId: otherOrg, chatbotId: otherBot })).toHaveLength(0);
  await expect(repository.retry({ ...input, organizationId: otherOrg }, 3)).rejects.toMatchObject({ status: 404 });
  const invalid = { ...input, documentId: randomUUID(), maxAttempts: 0 };
  await expect(repository.create(invalid)).rejects.toMatchObject({ code: '23514' });
  expect(await repository.get(invalid)).toBeNull();
});
it('claims atomically across workers and sets processing state exactly once', async () => {
  await repository.create(input);
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => repository.claim(`worker-${i}`)));
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(claims.find(Boolean)).toMatchObject({ attempts: 1, status: 'processing' });
  expect((await repository.get(input))?.status).toBe('processing');
});
it('retries with backoff, fails terminally, and serializes manual retries', async () => {
  await repository.create({ ...input, maxAttempts: 2 });
  const first = (await repository.claim('first'))!;
  await repository.fail(first, new Error('secret raw provider response'));
  expect((await repository.get(input))?.status).toBe('pending');
  expect(await repository.claim('too-early')).toBeNull();
  const queued = (await pool.query('SELECT status,last_error,available_at>now() AS delayed FROM document_ingestion_jobs')).rows[0];
  expect(queued).toEqual({ status: 'queued', last_error: 'Document processing failed.', delayed: true });
  await pool.query("UPDATE document_ingestion_jobs SET available_at=now()-interval '1 second'");
  const second = (await repository.claim('second'))!;
  await repository.fail(second, new IngestionError('embedding'));
  expect((await repository.get(input))?.status).toBe('failed');
  expect((await repository.get(input))?.error_message).toBe('Document embedding failed.');
  const retries = await Promise.allSettled([repository.retry(input, 3), repository.retry(input, 3)]);
  expect(retries.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await pool.query("SELECT * FROM document_ingestion_jobs WHERE status='queued'")).rows).toHaveLength(1);
});
it('recovers crashed workers, respects heartbeats and fences stale results', async () => {
  await repository.create(input);
  const first = (await repository.claim('same-worker'))!;
  await pool.query("UPDATE document_ingestion_jobs SET locked_at=now()-interval '10 minutes'");
  expect(await repository.heartbeat(first)).toBe(true);
  expect(await repository.recoverStale(3000)).toBe(0);
  await pool.query("UPDATE document_ingestion_jobs SET locked_at=now()-interval '10 minutes'");
  expect(await repository.recoverStale(3000)).toBe(1);
  await pool.query("UPDATE document_ingestion_jobs SET available_at=now()-interval '1 second'");
  const second = (await repository.claim('same-worker'))!;
  expect(second.attempts).toBe(2);
  expect(await repository.heartbeat(first)).toBe(false);
  await expect(repository.complete(first, result)).rejects.toBeInstanceOf(LeaseLostError);
  await expect(repository.fail(first, new Error())).rejects.toBeInstanceOf(LeaseLostError);
  await repository.complete(second, result);
  expect((await repository.get(input))?.status).toBe('ready');
});
it('marks a crashed final attempt failed instead of stranding it', async () => {
  await repository.create({ ...input, maxAttempts: 1 }); await repository.claim('crashed');
  await pool.query("UPDATE document_ingestion_jobs SET locked_at=now()-interval '10 minutes'");
  expect(await repository.recoverStale(3000)).toBe(1);
  expect((await repository.get(input))?.status).toBe('failed');
  expect((await pool.query('SELECT status,completed_at,locked_by FROM document_ingestion_jobs')).rows[0]).toMatchObject({ status: 'failed', completed_at: expect.any(Date), locked_by: null });
});
it('finalizes scoped chunks and embeddings atomically and reprocessing replaces existing rows', async () => {
  await repository.create(input);
  const job = (await repository.claim('worker'))!;
  // Simulate partial data from an older attempt: successful processing must replace it.
  await pool.query(`INSERT INTO document_chunks(organization_id,chatbot_id,document_id,chunk_index,content)
    VALUES($1,$2,$3,0,'old synthetic chunk')`, [input.organizationId, input.chatbotId, input.documentId]);
  await repository.complete(job, result);
  await expect(repository.complete(job, result)).rejects.toBeInstanceOf(LeaseLostError);
  expect((await repository.get(input))).toMatchObject({ status: 'ready', chunk_count: 1, page_count: 1, processed_at: expect.any(Date) });
  expect((await pool.query('SELECT * FROM document_chunks')).rows).toHaveLength(1);
  const vectors = (await pool.query('SELECT organization_id,chatbot_id,document_id,dimensions FROM document_embeddings')).rows;
  expect(vectors).toEqual([{ organization_id: input.organizationId, chatbot_id: input.chatbotId, document_id: input.documentId, dimensions: 1024 }]);
  await expect(pool.query('UPDATE document_embeddings SET organization_id=$1,chatbot_id=$2', [otherOrg, otherBot])).rejects.toMatchObject({ code: '23503' });
  await expect(pool.query('UPDATE document_chunks SET organization_id=$1,chatbot_id=$2', [otherOrg, otherBot])).rejects.toMatchObject({ code: '23503' });
});
it('rolls back chunk replacement, ready status and job completion on a failed transaction', async () => {
  await repository.create(input); const job = (await repository.claim('worker'))!;
  await pool.query(`INSERT INTO document_chunks(organization_id,chatbot_id,document_id,chunk_index,content)
    VALUES($1,$2,$3,0,'previous attempt')`, [input.organizationId, input.chatbotId, input.documentId]);
  // Invalid page count fails after new chunks/embeddings are written.
  await expect(repository.complete(job, { ...result, pageCount: 0 })).rejects.toMatchObject({ code: '23514' });
  expect((await repository.get(jobScope(job)))?.status).toBe('processing');
  expect((await pool.query('SELECT content FROM document_chunks')).rows).toEqual([{ content: 'previous attempt' }]);
  expect((await pool.query('SELECT * FROM document_embeddings')).rowCount).toBe(0);
  expect((await pool.query('SELECT status FROM document_ingestion_jobs')).rows[0].status).toBe('processing');
});
