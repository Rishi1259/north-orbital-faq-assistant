import type {
  EmbeddingProvider,
} from '../embeddings/types.js';

import {
  searchDocumentsHybrid,
} from './hybrid-searcher.js';

import {
  searchDocuments,
} from './searcher.js';

import type {
  DocumentChunk,
  SemanticDocumentIndex,
} from './types.js';

import {
  logger,
} from '../logging/logger.js';

export interface DocumentRetrieverOptions {
  semanticIndex?: SemanticDocumentIndex | null;
  embeddingProvider?: EmbeddingProvider;
  limit?: number;
  semanticMinimumScore?: number;
}

export async function retrieveDocumentChunks(
  query: string,
  chunks: DocumentChunk[],
  options: DocumentRetrieverOptions = {},
): Promise<DocumentChunk[]> {
  const limit =
    options.limit ?? 4;

  if (
    options.semanticIndex &&
    options.embeddingProvider
  ) {
    try {
      const hybridResults =
        await searchDocumentsHybrid(
          query,
          chunks,
          options.semanticIndex,
          options.embeddingProvider,
          {
            finalLimit: limit,
            semanticMinimumScore:
              options.semanticMinimumScore ??
              0.20,
          },
        );

      return hybridResults.map(
        (result) =>
          result.chunk,
      );
    } catch (error) {
      logger.warn(
  {
    err: error,
  },
  'Hybrid retrieval failed; falling back to lexical document search.',
);
    }
  }

  return searchDocuments(
    query,
    chunks,
    limit,
  ).map(
    (result) =>
      result.chunk,
  );
}
