import type { DocumentChunk, DocumentFormat } from '../documents/types.js';

export interface TenantScope { organizationId: string; chatbotId: string }
export interface DocumentScope extends TenantScope { documentId: string }
export interface StoredDocument {
  id: string;
  organization_id: string;
  chatbot_id: string;
  title: string;
  original_filename: string;
  mime_type: string;
  storage_key: string | null;
  checksum_sha256: string | null;
  size_bytes: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error_message: string | null;
  processed_at: Date | null;
  ocr_used: boolean;
  page_count: number | null;
  chunk_count: number | null;
  created_at: Date;
  updated_at: Date;
}
export interface IngestionJob {
  id: string;
  organization_id: string;
  chatbot_id: string;
  document_id: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed';
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
}
export interface NewDocument extends DocumentScope {
  filename: string;
  format: DocumentFormat;
  mimeType: string;
  storageKey: string;
  checksum: string;
  size: number;
  maxAttempts: number;
}
export interface ProcessingResult {
  chunks: DocumentChunk[];
  embeddings: number[][];
  provider: string;
  model: string;
  ocrUsed: boolean;
  pageCount: number | null;
}
export function jobScope(job: IngestionJob): DocumentScope {
  return { organizationId: job.organization_id, chatbotId: job.chatbot_id, documentId: job.document_id };
}
export function metadata(document: StoredDocument) {
  return {
    id: document.id, organizationId: document.organization_id, chatbotId: document.chatbot_id,
    title: document.title, originalFilename: document.original_filename, mimeType: document.mime_type,
    sizeBytes: document.size_bytes === null ? null : Number(document.size_bytes),
    status: document.status, errorMessage: document.error_message,
    processedAt: document.processed_at, ocrUsed: document.ocr_used,
    pageCount: document.page_count, chunkCount: document.chunk_count,
    createdAt: document.created_at, updatedAt: document.updated_at,
  };
}
