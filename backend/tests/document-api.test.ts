import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ChatbotNotFoundError } from '../src/chatbots/errors.js';
import { DocumentService } from '../src/ingestion/document-service.js';
import { DocumentError } from '../src/ingestion/errors.js';
import type { StoredDocument } from '../src/ingestion/types.js';

const org = randomUUID(); const bot = randomUUID(); const id = randomUUID();
const base = `/api/organizations/${org}/chatbots/${bot}/documents`;
const pdf = fileURLToPath(new URL('../../documents/samples/north-orbital-digital-access-guide.pdf', import.meta.url));
const docx = fileURLToPath(new URL('../../documents/samples/north-orbital-volunteer-handbook.docx', import.meta.url));
let document: StoredDocument;
const owns = (scope: { organizationId: string; chatbotId: string; documentId?: string }) =>
  scope.organizationId === org && scope.chatbotId === bot && (!scope.documentId || scope.documentId === document.id);
const repository = {
  create: vi.fn(async input => { document = { ...document, id: input.documentId, original_filename: input.filename }; return document; }),
  get: vi.fn(async scope => owns(scope) ? document : null),
  list: vi.fn(async scope => owns(scope) ? [document] : []),
  retry: vi.fn(async scope => {
    if (!owns(scope)) throw new DocumentError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
    if (document.status !== 'failed') throw new DocumentError(409, 'INVALID_DOCUMENT_STATE', 'Only failed documents can be retried.');
    document.status = 'pending'; return document;
  }),
};
const chatbots = { getById: vi.fn(async (organizationId, chatbotId) => {
  if (organizationId !== org || chatbotId !== bot) throw new ChatbotNotFoundError(); return {} as never;
}) };
const storage = { put: vi.fn(async () => {}), get: vi.fn(), delete: vi.fn(async () => {}) };
function app(maxBytes = 20971520) {
  return createApp({ provider: {} as never, documentChunks: [], semanticIndex: null,
    documentService: new DocumentService(chatbots, repository, storage, maxBytes, 3), uploadMaxBytes: maxBytes });
}
beforeEach(() => {
  vi.clearAllMocks();
  document = { id, organization_id: org, chatbot_id: bot, title: 'sample.pdf', original_filename: 'sample.pdf', mime_type: 'application/pdf',
    status: 'pending', storage_key: 'internal/path', checksum_sha256: 'internal-checksum', size_bytes: '100', error_message: null,
    processed_at: null, ocr_used: false, page_count: null, chunk_count: null, created_at: new Date(), updated_at: new Date() };
});
it.each([pdf, docx])('accepts a tenant-owned upload and returns safe pending metadata', async file => {
  const response = await request(app()).post(base).attach('file', file);
  expect(response.status).toBe(202);
  expect(response.body.document.status).toBe('pending');
  expect(response.body.document.storage_key).toBeUndefined();
  expect(response.text).not.toContain('internal/path');
  expect(storage.put).toHaveBeenCalledOnce(); expect(repository.create).toHaveBeenCalledOnce();
});
it('rejects unsupported, oversized, absent and unexpected file fields', async () => {
  expect((await request(app()).post(base).attach('file', Buffer.from('not a pdf'), 'test.pdf')).status).toBe(415);
  expect((await request(app(10)).post(base).attach('file', pdf)).status).toBe(413);
  expect((await request(app()).post(base).attach('other', pdf)).status).toBe(400);
  expect((await request(app()).post(base).send({})).status).toBe(400);
  expect(storage.put).not.toHaveBeenCalled();
});
it('checks tenant ownership before handling uploaded files', async () => {
  const response = await request(app()).post(base.replace(org, randomUUID())).attach('file', pdf);
  expect(response.status).toBe(404); expect(storage.put).not.toHaveBeenCalled(); expect(repository.create).not.toHaveBeenCalled();
});
it('lists and gets only owned documents, with pagination and UUID validation', async () => {
  expect((await request(app()).get(base)).body.documents).toHaveLength(1);
  expect(repository.list).toHaveBeenCalledWith({ organizationId: org, chatbotId: bot }, 50, 0);
  expect((await request(app()).get(`${base}/${id}`)).status).toBe(200);
  expect((await request(app()).get(`${base}/${randomUUID()}`)).status).toBe(404);
  expect((await request(app()).get(`${base.replace(org, randomUUID())}/${id}`)).status).toBe(404);
  expect((await request(app()).get(base.replace(org, randomUUID()))).status).toBe(404);
  expect((await request(app()).get(`${base}?limit=10000`)).status).toBe(400);
  expect((await request(app()).get(`${base}/invalid`)).status).toBe(400);
});
it('retries only a failed owned document', async () => {
  expect((await request(app()).post(`${base}/${id}/retry`)).status).toBe(409);
  document.status = 'failed';
  expect((await request(app()).post(`${base.replace(org, randomUUID())}/${id}/retry`)).status).toBe(404);
  expect((await request(app()).post(`${base}/${randomUUID()}/retry`)).status).toBe(404);
  expect((await request(app()).post(`${base}/${id}/retry`)).status).toBe(202);
  expect((await request(app()).post(`${base}/${id}/retry`)).status).toBe(409);
});
it('cleans up storage when database creation fails and returns no internal errors', async () => {
  repository.create.mockRejectedValueOnce(new Error('postgres password secret and document content'));
  const response = await request(app()).post(base).attach('file', pdf);
  expect(response.status).toBe(500); expect(response.text).not.toContain('secret');
  expect(storage.delete).toHaveBeenCalledOnce();
});
