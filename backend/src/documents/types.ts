export type DocumentFormat =
  | 'pdf'
  | 'docx';

export interface ExtractedBlock {
  id: string;
  text: string;
  page?: number;
  section?: string;
}

export interface ExtractedDocument {
  id: string;
  fileName: string;
  sourcePath: string;
  format: DocumentFormat;
  title: string;
  blocks: ExtractedBlock[];
  warnings: string[];
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  fileName: string;
  sourcePath: string;
  format: DocumentFormat;
  blockId: string;
  text: string;
  page?: number;
  section?: string;
}

export interface DocumentIndex {
  generatedAt: string;
  chunks: DocumentChunk[];
}

export interface DocumentSearchResult {
  chunk: DocumentChunk;
  score: number;
}
