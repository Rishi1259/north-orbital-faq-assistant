import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, copyFile, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { storageKey } from '../src/storage/object-storage.js';
import { pdfTextQuality } from '../src/ingestion/quality.js';
import { IngestionError, safeProcessingError } from '../src/ingestion/errors.js';
import { failureState, retryDelayMs } from '../src/ingestion/repository.js';
import { validateUpload, sanitizeFilename, MIME_TYPES } from '../src/ingestion/upload-validation.js';
import { processJob } from '../src/ingestion/processor.js';
import type { ExtractedDocument } from '../src/documents/types.js';
import { loadEnvironment } from '../src/config.js';
import { CommandOcrProvider } from '../src/ingestion/ocr.js';

const samples = fileURLToPath(new URL('../../documents/samples/', import.meta.url));
const pdf = path.join(samples, 'north-orbital-digital-access-guide.pdf');
const docx = path.join(samples, 'north-orbital-volunteer-handbook.docx');
const scope = { organizationId: randomUUID(), chatbotId: randomUUID(), documentId: randomUUID() };
const healthy: ExtractedDocument = { id: 'legacy', fileName: 'source.pdf', sourcePath: 'source', format: 'pdf',
  title: 'Document', blocks: [{ id: 'page-1', text: 'Useful document information with letters and numbers. '.repeat(10), page: 1 }], warnings: [], pageCount: 1 };
const poor = { ...healthy, blocks: [] };

it('constructs tenant-owned storage keys without raw filenames and rejects paths', () => {
  expect(storageKey({ ...scope, format: 'pdf' })).toBe(`organizations/${scope.organizationId}/chatbots/${scope.chatbotId}/documents/${scope.documentId}/source.pdf`);
  for (const field of ['organizationId', 'chatbotId', 'documentId', 'format']) {
    expect(() => storageKey({ ...scope, format: 'pdf', [field]: '../escape' })).toThrow();
  }
  expect(storageKey({ ...scope, organizationId: scope.organizationId.toUpperCase(), format: 'pdf' }))
    .toBe(storageKey({ ...scope, format: 'pdf' }));
  expect(sanitizeFilename('..\\private/secret\u0000.pdf')).toBe('secret.pdf');
});
it('validates configuration booleans, credential pairs, model and bounds', () => {
  expect(loadEnvironment({ DATABASE_URL: 'postgres://test' }).OCR_ENABLED).toBe(false);
  expect(loadEnvironment({ DATABASE_URL: 'postgres://test', OCR_ENABLED: 'true' }).OCR_ENABLED).toBe(true);
  for (const invalid of [{ OCR_ENABLED: 'yes' }, { INGESTION_MAX_ATTEMPTS: '0' },
    { INGESTION_EMBEDDING_CONCURRENCY: '1000' }, { OLLAMA_EMBEDDING_MODEL: 'wrong' }, { OBJECT_STORAGE_ACCESS_KEY: 'only-key' }]) {
    expect(() => loadEnvironment({ DATABASE_URL: 'postgres://test', ...invalid })).toThrow();
  }
});
it('checks actual PDF and DOCX bytes, extension, size and SHA-256', async () => {
  expect(await validateUpload(pdf, 'guide.pdf', 20971520)).toMatchObject({ format: 'pdf', mimeType: MIME_TYPES.pdf, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await validateUpload(docx, 'guide.docx', 20971520)).toMatchObject({ format: 'docx' });
  await expect(validateUpload(pdf, 'guide.docx', 20971520)).rejects.toMatchObject({ status: 415 });
  await expect(validateUpload(pdf, 'guide.pdf', 10)).rejects.toMatchObject({ status: 413 });
  const directory = await mkdtemp(path.join(tmpdir(), 'validation-test-'));
  try {
    const file = path.join(directory, 'fake.pdf');
    for (const content of ['plain text', '', 'PK\x03\x04not-a-word-archive']) {
      await writeFile(file, content);
      await expect(validateUpload(file, 'fake.pdf', 100)).rejects.toMatchObject({ status: 415 });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('uses total page count including blank pages and ignores punctuation for PDF quality', () => {
  expect(pdfTextQuality(healthy).usable).toBe(true);
  expect(pdfTextQuality(poor).usable).toBe(false);
  expect(pdfTextQuality({ ...healthy, pageCount: 10 }).usable).toBe(false);
  expect(pdfTextQuality({ ...healthy, blocks: [{ id: 'x', page: 1, text: '! � '.repeat(100) }] }).usable).toBe(false);
});
it('caps exponential backoff and stops retrying at the configured maximum', () => {
  expect([1, 2, 3, 20].map(retryDelayMs)).toEqual([1000, 2000, 4000, 300000]);
  expect(failureState(2, 3)).toBe('queued');
  expect(failureState(3, 3)).toBe('failed');
  expect(safeProcessingError(new Error('secret text, credentials and provider response'))).toBe('Document processing failed.');
  expect(safeProcessingError(new IngestionError('embedding'))).toBe('Document embedding failed.');
});
it('reports missing OCR commands and timeouts with safe errors', async () => {
  await expect(new CommandOcrProvider('/missing-ocr-binary', 100).process('/tmp/input', '/tmp/output')).rejects.toThrow('PDF OCR processing failed.');
  // Node waits on an unread input stream, allowing a timeout without OCR installed.
  const directory = await mkdtemp(path.join(tmpdir(), 'ocr-command-test-'));
  try {
    const script = path.join(directory, 'sleep-ocr');
    await writeFile(script, '#!/bin/sh\nsleep 30\n', { mode: 0o700 });
    const start = Date.now();
    await expect(new CommandOcrProvider(script, 100).process('/tmp/input', '/tmp/output')).rejects.toThrow('PDF OCR processing failed.');
    expect(Date.now() - start).toBeLessThan(5000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function fixture(format: 'pdf' | 'docx' = 'pdf') {
  const source = format === 'pdf' ? pdf : docx;
  const bytes = await readFile(source);
  const job = { id: randomUUID(), organization_id: scope.organizationId, chatbot_id: scope.chatbotId,
    document_id: scope.documentId, status: 'processing' as const, attempts: 1, max_attempts: 3, locked_by: 'worker' };
  const repository = {
    get: vi.fn(async () => ({ id: scope.documentId, mime_type: MIME_TYPES[format],
      storage_key: storageKey({ ...scope, format }), checksum_sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: String(bytes.length) })),
    heartbeat: vi.fn(async () => true), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}),
  };
  const storage = { put: vi.fn(), delete: vi.fn(), get: vi.fn(async (_object, destination) => { await copyFile(source, destination); }) };
  const extract = vi.fn(async () => ({ ...healthy, format }));
  const embeddings = { embed: vi.fn(async (inputs: string[]) => inputs.map(() => Array(1024).fill(0.1))) };
  const ocr = { process: vi.fn(async () => {}) };
  const lines: string[] = [];
  const logger = pino({ level: 'info' }, { write: line => { lines.push(line); } });
  const options = { repository: repository as never, storage, extract, embeddings, ocr, logger,
    model: 'qwen3-embedding:0.6b', concurrency: 2, staleAfterMs: 3000, maxBytes: 20971520 };
  return { job, repository, storage, extract, embeddings, ocr, lines, options };
}
describe('worker with fake external dependencies', () => {
  it.each(['pdf', 'docx'] as const)('processes %s and removes temp files without logging content', async format => {
    const f = await fixture(format);
    await processJob(f.job, f.options);
    expect(f.repository.complete).toHaveBeenCalledWith(f.job, expect.objectContaining({ ocrUsed: false,
      pageCount: format === 'pdf' ? 1 : null, chunks: expect.any(Array), embeddings: expect.any(Array) }));
    expect(f.repository.fail).not.toHaveBeenCalled();
    expect(f.ocr.process).not.toHaveBeenCalled();
    await expect(access(f.storage.get.mock.calls[0][1])).rejects.toThrow();
    expect(f.lines.join('')).not.toContain(healthy.blocks[0].text);
    expect(f.lines.join('')).not.toContain('[0.1,0.1');
  });
  it('uses OCR only for poor PDFs and extracts the OCR output again', async () => {
    const f = await fixture();
    f.extract.mockResolvedValueOnce(poor);
    await processJob(f.job, f.options);
    expect(f.ocr.process).toHaveBeenCalledOnce();
    expect(f.extract).toHaveBeenCalledTimes(2);
    expect(f.repository.complete).toHaveBeenCalledWith(f.job, expect.objectContaining({ ocrUsed: true }));
  });
  it('fails safely when OCR is disabled or fails to recover useful text', async () => {
    const f = await fixture(); f.extract.mockResolvedValue(poor);
    await processJob(f.job, { ...f.options, ocr: undefined });
    expect(f.repository.fail).toHaveBeenLastCalledWith(f.job, new IngestionError('ocr_disabled'));
    expect(f.ocr.process).not.toHaveBeenCalled();
    await processJob(f.job, f.options);
    expect(f.repository.fail).toHaveBeenLastCalledWith(f.job, new IngestionError('quality'));
    expect(f.repository.complete).not.toHaveBeenCalled();
  });
  it.each(['extraction', 'embedding', 'ocr', 'persistence'] as const)('handles %s failures without leaking messages', async stage => {
    const f = await fixture(); const error = new Error('private content or credentials');
    if (stage === 'extraction') f.extract.mockRejectedValue(error);
    if (stage === 'embedding') f.embeddings.embed.mockRejectedValue(error);
    if (stage === 'ocr') { f.extract.mockResolvedValue(poor); f.ocr.process.mockRejectedValue(error); }
    if (stage === 'persistence') f.repository.complete.mockRejectedValue(error);
    await processJob(f.job, f.options);
    expect(f.repository.fail).toHaveBeenCalledWith(f.job, new IngestionError(stage));
    expect(f.lines.join('')).not.toContain(error.message);
    await expect(access(f.storage.get.mock.calls[0][1])).rejects.toThrow();
  });
  it('rejects wrong embedding dimensions', async () => {
    const f = await fixture(); f.embeddings.embed.mockResolvedValue([[1, 2]]);
    await processJob(f.job, f.options);
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.repository.fail).toHaveBeenCalledWith(f.job, new IngestionError('embedding'));
  });
  it('bounds embedding requests and preserves chunk order', async () => {
    const f = await fixture(); let active = 0; let peak = 0;
    f.extract.mockResolvedValue({ ...healthy, blocks: Array.from({ length: 7 }, (_, i) => ({ id: `block-${i}`, text: 'Readable text with enough content. '.repeat(5), page: i + 1 })), pageCount: 7 });
    f.embeddings.embed.mockImplementation(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return [Array(1024).fill(0.1)];
    });
    await processJob(f.job, f.options);
    expect(peak).toBe(2);
    const result = f.repository.complete.mock.calls[0] as unknown as [unknown, {chunks: {page: number}[]}];
    expect(result[1].chunks.map(c => c.page)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('does not commit after losing a heartbeat', async () => {
    const f = await fixture(); f.repository.heartbeat.mockResolvedValue(false);
    f.embeddings.embed.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 1100)); return [Array(1024).fill(0.1)];
    });
    await processJob(f.job, f.options);
    expect(f.repository.complete).not.toHaveBeenCalled(); expect(f.repository.fail).not.toHaveBeenCalled();
  });
  it('rejects another tenant storage key before download', async () => {
    const f = await fixture(); const doc = await f.repository.get(); doc.storage_key = storageKey({ ...scope, organizationId: randomUUID(), format: 'pdf' });
    f.repository.get.mockResolvedValue(doc);
    await processJob(f.job, f.options);
    expect(f.storage.get).not.toHaveBeenCalled();
    expect(f.repository.fail).toHaveBeenCalledWith(f.job, new IngestionError('download'));
  });
});

it('rejects original upload path tricks rather than accepting them as metadata', async () => {
  for (const filename of ['../sample.pdf', '/absolute.pdf', 'C:\\sample.pdf', 'bad\u0000.pdf']) {
    await expect(validateUpload(path.join(samples, 'north-orbital-digital-access-guide.pdf'), filename, 20971520)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  }
});
