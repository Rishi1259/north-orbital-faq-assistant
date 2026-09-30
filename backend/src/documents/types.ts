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

export interface SemanticIndexEntry {
  chunkId: string;
  embedding: number[];
}

export interface SemanticDocumentIndex {
  generatedAt: string;
  model: string;
  dimensions: number;
  entries: SemanticIndexEntry[];
}

export interface SemanticSearchResult {
  chunk: DocumentChunk;
  score: number;
}

export interface HybridSearchResult {
  chunk: DocumentChunk;
  lexicalScore: number;
  semanticScore: number;
  hybridScore: number;
}
