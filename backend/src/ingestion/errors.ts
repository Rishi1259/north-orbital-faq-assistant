export class DocumentError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}
const processingMessages = {
  download: 'Document download failed.',
  extraction: 'Document text extraction failed.',
  quality: 'Document contains insufficient readable text.',
  ocr_disabled: 'PDF requires OCR, but OCR is disabled.',
  ocr: 'PDF OCR processing failed.',
  embedding: 'Document embedding failed.',
  persistence: 'Document processing could not be saved.',
  stale: 'Worker lease expired before processing completed.',
} as const;
export class IngestionError extends Error {
  constructor(public readonly code: keyof typeof processingMessages) { super(processingMessages[code]); }
}
// Never persist provider/parser/DB error messages: they can contain document text or secrets.
export function safeProcessingError(error: unknown): string {
  return error instanceof IngestionError ? processingMessages[error.code] : 'Document processing failed.';
}
export class LeaseLostError extends Error { constructor() { super('Worker lease lost.'); } }
