import { smokeSession } from './smoke-session.mjs';
// Opt-in end-to-end check against a running Compose stack. Creates only synthetic
// tenants, uploads public samples, and removes only its own rows/objects afterward.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { loadEnvironment } from '../dist/config.js';
import { S3ObjectStorage } from '../dist/storage/object-storage.js';

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const storage = new S3ObjectStorage(environment);
let session;
const root = process.env.INGESTION_TEST_API_URL ?? 'http://backend:3000';
const createdOrgs = [];
const createdObjects = [];
const directory = await mkdtemp(path.join(tmpdir(), 'ingestion-smoke-'));
async function api(url, options) {
  const response = await session.fetch(`${root}/api${url}`, options);
  const body = await response.json();
  assert.ok(response.ok, `Unexpected API status ${response.status}`);
  return { response, body };
}
async function tenant() {
  const { body } = await api('/organizations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Milestone 23 smoke test', slug: `m23-smoke-${randomUUID()}` }) });
  createdOrgs.push(body.organization.id);
  const bot = await api(`/organizations/${body.organization.id}/chatbots`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ingestion smoke test' }) });
  return { organizationId: body.organization.id, chatbotId: bot.body.chatbot.id };
}
async function waitFor(base, documentId, expected) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const { body } = await api(`${base}/${documentId}`);
    if (body.document.status === expected) return body.document;
    assert.notEqual(body.document.status, expected === 'ready' ? 'failed' : 'ready', 'Unexpected terminal status');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Document processing deadline exceeded.');
}
try {
  session = await smokeSession(pool, root);
  const owner = await tenant(); const other = await tenant();
  const base = `/organizations/${owner.organizationId}/chatbots/${owner.chatbotId}/documents`;
  const wrongBase = base.replace(owner.organizationId, other.organizationId);
  const scan = path.join(directory, 'scanned.pdf');
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./verify-ocr.mjs', import.meta.url))],
    { env: { ...process.env, OCR_SCAN_OUTPUT: scan } });
  const samples = [
    { file: fileURLToPath(new URL('../../documents/samples/north-orbital-digital-access-guide.pdf', import.meta.url)), format: 'pdf', ocr: false },
    { file: fileURLToPath(new URL('../../documents/samples/north-orbital-volunteer-handbook.docx', import.meta.url)), format: 'docx', ocr: false },
    { file: scan, format: 'pdf', ocr: true },
  ];
  for (const sample of samples) {
    const form = new FormData(); form.append('file', new Blob([await readFile(sample.file)]), `sample.${sample.format}`);
    const { response, body } = await api(base, { method: 'POST', body: form });
    assert.equal(response.status, 202); assert.equal(body.document.status, 'pending');
    const object = { ...owner, documentId: body.document.id, format: sample.format }; createdObjects.push(object);
    assert.equal((await session.fetch(`${root}/api${wrongBase}/${body.document.id}`)).status, 404);
    assert.equal((await session.fetch(`${root}/api${wrongBase}/${body.document.id}/retry`, { method: 'POST' })).status, 404);
    const ready = await waitFor(base, body.document.id, 'ready');
    assert.equal(ready.ocrUsed, sample.ocr); assert.ok(ready.chunkCount > 0);
    const counts = (await pool.query(`SELECT count(*)::integer AS chunks, min(e.dimensions) AS dimensions
      FROM document_chunks c JOIN document_embeddings e ON e.chunk_id=c.id AND e.organization_id=c.organization_id
      AND e.chatbot_id=c.chatbot_id AND e.document_id=c.document_id
      WHERE c.organization_id=$1 AND c.chatbot_id=$2 AND c.document_id=$3`,
    [owner.organizationId, owner.chatbotId, body.document.id])).rows[0];
    assert.equal(counts.chunks, ready.chunkCount); assert.equal(counts.dimensions, 1024);
    const downloaded = path.join(directory, `download-${body.document.id}`);
    await storage.get(object, downloaded);
    assert.deepEqual(await readFile(downloaded), await readFile(sample.file));
    console.log(`End-to-end ${sample.ocr ? 'scanned PDF with OCR' : sample.format.toUpperCase()}: ready; ${ready.chunkCount} chunks with 1024-dimensional vectors; raw object verified.`);
  }
  const invalid = new FormData(); invalid.append('file', new Blob(['%PDF-1.7\ninvalid synthetic PDF']), 'invalid.pdf');
  const { body } = await api(base, { method: 'POST', body: invalid });
  createdObjects.push({ ...owner, documentId: body.document.id, format: 'pdf' });
  const failed = await waitFor(base, body.document.id, 'failed');
  assert.equal(failed.errorMessage, 'Document text extraction failed.');
  const jobs = (await pool.query(`SELECT status, attempts, max_attempts FROM document_ingestion_jobs
    WHERE organization_id=$1 AND chatbot_id=$2 AND document_id=$3`, [owner.organizationId, owner.chatbotId, body.document.id])).rows;
  assert.equal(jobs[0].attempts, jobs[0].max_attempts); assert.equal(jobs[0].status, 'failed');
  assert.equal((await api(`${base}/${body.document.id}/retry`, { method: 'POST' })).response.status, 202);
  await waitFor(base, body.document.id, 'failed');
  console.log('End-to-end failure retries, terminal status, manual retry and wrong-tenant access: passed.');
} catch (error) {
  // Print only a fixed diagnostic; provider/DB response details may contain sensitive data.
  console.error('Ingestion end-to-end check failed; inspect safe worker status logs.');
  process.exitCode = 1;
} finally {
  for (const object of createdObjects) await storage.delete(object);
  for (const id of createdOrgs) await pool.query('DELETE FROM organizations WHERE id=$1', [id]);
  await rm(directory, { recursive: true, force: true });
  await session?.close(); storage.close(); await pool.end();
}
