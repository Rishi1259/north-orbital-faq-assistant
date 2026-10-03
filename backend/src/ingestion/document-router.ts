import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { ChatbotNotFoundError } from '../chatbots/errors.js';
import { logger } from '../logging/logger.js';
import { DocumentError } from './errors.js';
import type { DocumentService } from './document-service.js';

function scope(request: Request) {
  return { organizationId: z.uuid().parse(request.params.organizationId), chatbotId: z.uuid().parse(request.params.chatbotId) };
}
function documentScope(request: Request) { return { ...scope(request), documentId: z.uuid().parse(request.params.documentId) }; }
function sendError(response: Response, error: unknown) {
  let failure = new DocumentError(500, 'INTERNAL_ERROR', 'Document request could not be completed.');
  if (error instanceof DocumentError) failure = error;
  else if (error instanceof ChatbotNotFoundError) failure = new DocumentError(404, 'DOCUMENT_NOT_FOUND', 'Document or chatbot not found.');
  else if (error instanceof ZodError) failure = new DocumentError(400, 'INVALID_REQUEST', 'Invalid document request.');
  else if (error instanceof multer.MulterError) failure = error.code === 'LIMIT_FILE_SIZE'
    ? new DocumentError(413, 'UPLOAD_TOO_LARGE', 'Uploaded file exceeds the size limit.')
    : new DocumentError(400, 'INVALID_UPLOAD', 'Upload exactly one file using the file field.');
  if (failure.status === 500) logger.error({ requestId: response.getHeader('X-Request-Id') }, 'Document request failed.');
  response.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
}
export function createDocumentRouter(service: DocumentService, maxBytes: number): Router {
  const router = Router();
  const base = '/organizations/:organizationId/chatbots/:chatbotId/documents';
  router.post(base, async (request, response) => {
    let directory: string | undefined;
    try {
      const tenant = scope(request);
      // Ownership checked before creating a temporary directory or reading multipart data.
      await service.assertTenant(tenant);
      if (!request.is('multipart/form-data')) throw new DocumentError(400, 'INVALID_UPLOAD', 'Use multipart/form-data with a file field.');
      directory = await mkdtemp(path.join(tmpdir(), 'document-upload-'));
      const upload = multer({ dest: directory, limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 } }).single('file');
      await new Promise<void>((resolve, reject) => upload(request, response, error => {
        if (error) reject(error instanceof multer.MulterError ? error : new DocumentError(400, 'INVALID_UPLOAD', 'Malformed multipart upload.'));
        else resolve();
      }));
      if (!request.file) throw new DocumentError(400, 'MISSING_FILE', 'A file field is required.');
      const document = await service.upload(tenant, request.file.path, request.file.originalname);
      response.status(202).json({ document });
    } catch (error) { sendError(response, error); }
    finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {
        logger.warn({ requestId: response.getHeader('X-Request-Id') }, 'Upload temporary cleanup failed.');
      });
    }
  });
  router.get(base, async (request, response) => {
    try {
      const limit = z.coerce.number().int().min(1).max(100).default(50).parse(request.query.limit);
      const offset = z.coerce.number().int().min(0).max(1000000).default(0).parse(request.query.offset);
      response.json({ documents: await service.list(scope(request), limit, offset), limit, offset });
    } catch (error) { sendError(response, error); }
  });
  router.get(`${base}/:documentId`, async (request, response) => {
    try { response.json({ document: await service.get(documentScope(request)) }); }
    catch (error) { sendError(response, error); }
  });
  router.post(`${base}/:documentId/retry`, async (request, response) => {
    try { response.status(202).json({ document: await service.retry(documentScope(request)) }); }
    catch (error) { sendError(response, error); }
  });
  return router;
}
