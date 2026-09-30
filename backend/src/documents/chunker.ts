import type {
  DocumentChunk,
  ExtractedDocument,
} from './types.js';

export interface ChunkOptions {
  maxWords?: number;
  overlapWords?: number;
}

function splitWords(text: string): string[] {
  return text
    .split(/\s+/)
    .filter(Boolean);
}

export function chunkDocument(
  document: ExtractedDocument,
  options: ChunkOptions = {},
): DocumentChunk[] {
  const maxWords =
    options.maxWords ?? 140;

  const overlapWords =
    options.overlapWords ?? 30;

  if (overlapWords >= maxWords) {
    throw new Error(
      'overlapWords must be smaller than maxWords.',
    );
  }

  const chunks: DocumentChunk[] = [];

  for (const block of document.blocks) {
    const words = splitWords(block.text);

    if (words.length === 0) {
      continue;
    }

    let start = 0;
    let chunkNumber = 1;

    while (start < words.length) {
      const end = Math.min(
        start + maxWords,
        words.length,
      );

      const text = words
        .slice(start, end)
        .join(' ');

      chunks.push({
        id:
          `${block.id}-C${String(chunkNumber).padStart(3, '0')}`,
        documentId: document.id,
        documentTitle: document.title,
        fileName: document.fileName,
        sourcePath: document.sourcePath,
        format: document.format,
        blockId: block.id,
        text,
        page: block.page,
        section: block.section,
      });

      if (end >= words.length) {
        break;
      }

      start = end - overlapWords;
      chunkNumber += 1;
    }
  }

  return chunks;
}

export function chunkDocuments(
  documents: ExtractedDocument[],
  options?: ChunkOptions,
): DocumentChunk[] {
  return documents.flatMap(
    (document) =>
      chunkDocument(
        document,
        options,
      ),
  );
}
