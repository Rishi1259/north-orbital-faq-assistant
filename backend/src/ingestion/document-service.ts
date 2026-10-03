import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatbotService } from '../chatbots/chatbot-service.js';
import { storageKey, type ObjectStorage } from '../storage/object-storage.js';
import { logger } from '../logging/logger.js';
import { DocumentError } from './errors.js';
import type { IngestionRepository } from './repository.js';
import { metadata, type DocumentScope, type TenantScope } from './types.js';
import { validateUpload } from './upload-validation.js';

export class DocumentService {
  constructor(private readonly chatbots: Pick<ChatbotService, 'getById'>,
    private readonly repository: Pick<IngestionRepository, 'create' | 'get' | 'list' | 'retry'>,
    private readonly storage: ObjectStorage, private readonly maxBytes: number,
    private readonly maxAttempts: number) {}
  async assertTenant(scope: TenantScope) {
    z.uuid().parse(scope.organizationId); z.uuid().parse(scope.chatbotId);
    await this.chatbots.getById(scope.organizationId, scope.chatbotId);
  }
  async upload(scope: TenantScope, filePath: string, filename: string) {
    await this.assertTenant(scope);
    const upload = await validateUpload(filePath, filename, this.maxBytes);
    const object = { ...scope, documentId: randomUUID(), format: upload.format };
    try {
      await this.storage.put(object, filePath, upload.mimeType);
      return metadata(await this.repository.create({ ...object, ...upload,
        storageKey: storageKey(object), maxAttempts: this.maxAttempts }));
    } catch (error) {
      // Also clean up ambiguous put failures; a timed-out put may have succeeded remotely.
      try { await this.storage.delete(object); } catch {
        logger.warn({ ...scope, documentId: object.documentId }, 'Uploaded object cleanup failed.');
      }
      throw error;
    }
  }
  async list(scope: TenantScope, limit: number, offset: number) {
    await this.assertTenant(scope);
    return (await this.repository.list(scope, limit, offset)).map(metadata);
  }
  async get(scope: DocumentScope) {
    await this.assertTenant(scope); z.uuid().parse(scope.documentId);
    const document = await this.repository.get(scope);
    if (!document) throw new DocumentError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
    return metadata(document);
  }
  async retry(scope: DocumentScope) {
    await this.assertTenant(scope); z.uuid().parse(scope.documentId);
    return metadata(await this.repository.retry(scope, this.maxAttempts));
  }
}
