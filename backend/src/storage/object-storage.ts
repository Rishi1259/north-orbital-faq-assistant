import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { DocumentFormat } from '../documents/types.js';
import type { DocumentScope } from '../ingestion/types.js';
import type { Environment } from '../config.js';

export interface StorageObject extends DocumentScope { format: DocumentFormat }
export function storageKey(object: StorageObject): string {
  const id = z.uuid();
  const organizationId = id.parse(object.organizationId).toLowerCase();
  const chatbotId = id.parse(object.chatbotId).toLowerCase();
  const documentId = id.parse(object.documentId).toLowerCase();
  const format = z.enum(['pdf', 'docx']).parse(object.format);
  return `organizations/${organizationId}/chatbots/${chatbotId}/documents/${documentId}/source.${format}`;
}
export interface ObjectStorage {
  put(object: StorageObject, filePath: string, mimeType: string): Promise<void>;
  get(object: StorageObject, filePath: string): Promise<void>;
  delete(object: StorageObject): Promise<void>;
}
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  constructor(private readonly config: Environment) {
    this.client = new S3Client({
      endpoint: config.OBJECT_STORAGE_ENDPOINT,
      region: config.OBJECT_STORAGE_REGION,
      forcePathStyle: config.OBJECT_STORAGE_FORCE_PATH_STYLE,
      // No static credentials means the standard AWS IAM credential provider chain.
      credentials: config.OBJECT_STORAGE_ACCESS_KEY && config.OBJECT_STORAGE_SECRET_KEY
        ? { accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: config.OBJECT_STORAGE_SECRET_KEY }
        : undefined,
      maxAttempts: 3,
    });
  }
  async put(object: StorageObject, filePath: string, mimeType: string) {
    const body = createReadStream(filePath);
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.config.OBJECT_STORAGE_BUCKET,
        Key: storageKey(object), Body: body, ContentLength: (await stat(filePath)).size, ContentType: mimeType }),
      { abortSignal: AbortSignal.timeout(this.config.OBJECT_STORAGE_TIMEOUT_MS) });
    } finally { body.destroy(); }
  }
  async get(object: StorageObject, filePath: string) {
    const signal = AbortSignal.timeout(this.config.OBJECT_STORAGE_TIMEOUT_MS);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.OBJECT_STORAGE_BUCKET,
      Key: storageKey(object) }), { abortSignal: signal });
    if (!result.Body) throw new Error('Missing object body.');
    let bytes = 0;
    const limit = this.config.UPLOAD_MAX_BYTES;
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > limit ? new Error('Object exceeds size limit.') : null, chunk);
    } });
    await pipeline(result.Body as NodeJS.ReadableStream, bounded,
      createWriteStream(filePath, { flags: 'wx', mode: 0o600 }), { signal });
  }
  async delete(object: StorageObject) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.OBJECT_STORAGE_BUCKET,
      Key: storageKey(object) }), { abortSignal: AbortSignal.timeout(this.config.OBJECT_STORAGE_TIMEOUT_MS) });
  }
  close() { this.client.destroy(); }
}
