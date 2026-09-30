import type {
  EmbeddingProvider,
} from '../embeddings/types.js';

import type {
  DocumentChunk,
  SemanticDocumentIndex,
} from './types.js';

export interface SemanticIndexOptions {
  model: string;
  batchSize?: number;
}

export function embeddingTextForChunk(
  chunk: DocumentChunk,
): string {
  const location =
    chunk.page
      ? `Page ${chunk.page}`
      : chunk.section
        ? `Section: ${chunk.section}`
        : 'Document';

  return [
    `Document: ${chunk.documentTitle}`,
    location,
    chunk.text,
  ].join('\n');
}

export async function buildSemanticIndex(
  chunks: DocumentChunk[],
  provider: EmbeddingProvider,
  options: SemanticIndexOptions,
): Promise<SemanticDocumentIndex> {
  const batchSize =
    options.batchSize ?? 8;

  if (batchSize < 1) {
    throw new Error(
      'batchSize must be at least 1.',
    );
  }

  const entries:
    SemanticDocumentIndex['entries'] =
      [];

  let dimensions = 0;

  for (
    let start = 0;
    start < chunks.length;
    start += batchSize
  ) {
    const batch =
      chunks.slice(
        start,
        start + batchSize,
      );

    const embeddings =
      await provider.embed(
        batch.map(
          embeddingTextForChunk,
        ),
      );

    if (
      embeddings.length !==
      batch.length
    ) {
      throw new Error(
        'Embedding count does not match chunk count.',
      );
    }

    for (
      let index = 0;
      index < batch.length;
      index += 1
    ) {
      const chunk =
        batch[index];

      const embedding =
        embeddings[index];

      if (
        !chunk ||
        !embedding
      ) {
        throw new Error(
          'Missing semantic index data.',
        );
      }

      if (dimensions === 0) {
        dimensions =
          embedding.length;
      }

      if (
        embedding.length !==
        dimensions
      ) {
        throw new Error(
          'Embedding dimensions are inconsistent.',
        );
      }

      entries.push({
        chunkId:
          chunk.id,
        embedding,
      });
    }
  }

  return {
    generatedAt:
      new Date().toISOString(),

    model:
      options.model,

    dimensions,

    entries,
  };
}
