import type {
  EmbeddingProvider,
} from '../embeddings/types.js';

import {
  searchDocuments,
} from './searcher.js';

import {
  searchDocumentsSemantic,
} from './semantic-searcher.js';

import type {
  DocumentChunk,
  HybridSearchResult,
  SemanticDocumentIndex,
} from './types.js';

export interface HybridSearchOptions {
  lexicalLimit?: number;
  semanticLimit?: number;
  finalLimit?: number;

  lexicalWeight?: number;
  semanticWeight?: number;

  semanticMinimumScore?: number;
}

export async function searchDocumentsHybrid(
  query: string,
  chunks: DocumentChunk[],
  semanticIndex: SemanticDocumentIndex,
  embeddingProvider: EmbeddingProvider,
  options: HybridSearchOptions = {},
): Promise<HybridSearchResult[]> {
  const lexicalLimit =
    options.lexicalLimit ??
    8;

  const semanticLimit =
    options.semanticLimit ??
    8;

  const finalLimit =
    options.finalLimit ??
    4;

  const lexicalWeight =
    options.lexicalWeight ??
    0.15;

  const semanticWeight =
    options.semanticWeight ??
    0.85;

  const semanticMinimumScore =
    options.semanticMinimumScore ??
    0.20;

  if (
    lexicalWeight < 0 ||
    semanticWeight < 0 ||
    lexicalWeight +
      semanticWeight ===
      0
  ) {
    throw new Error(
      'Hybrid search weights must be positive.',
    );
  }

  const lexicalResults =
    searchDocuments(
      query,
      chunks,
      lexicalLimit,
    );

  const semanticQuery =
    [
      'Instruct: Given a user question, retrieve relevant passages from the available documents that answer the question.',
      `Query: ${query}`,
    ].join('\n');

  const queryEmbeddings =
    await embeddingProvider.embed([
      semanticQuery,
    ]);

  const queryEmbedding =
    queryEmbeddings[0];

  if (!queryEmbedding) {
    throw new Error(
      'Embedding provider returned no query embedding.',
    );
  }

  const semanticResults =
    searchDocumentsSemantic(
      queryEmbedding,
      chunks,
      semanticIndex,
      semanticLimit,
      semanticMinimumScore,
    );

  const normalizeLexicalScore = (
    score: number,
  ): number => {
    if (score <= 0) {
      return 0;
    }

    // Saturating normalization.
    // A single token overlap should not become
    // a perfect lexical match merely because
    // it is the best lexical result.
    return score / (score + 8);
  };

  const merged =
    new Map<
      string,
      HybridSearchResult
    >();

  for (
    const lexicalResult of lexicalResults
  ) {
    merged.set(
      lexicalResult.chunk.id,
      {
        chunk:
          lexicalResult.chunk,

        lexicalScore:
          normalizeLexicalScore(
            lexicalResult.score,
          ),

        semanticScore: 0,

        hybridScore: 0,
      },
    );
  }

  for (
    const semanticResult of semanticResults
  ) {
    const existing =
      merged.get(
        semanticResult.chunk.id,
      );

    if (existing) {
      existing.semanticScore =
        semanticResult.score;

      continue;
    }

    merged.set(
      semanticResult.chunk.id,
      {
        chunk:
          semanticResult.chunk,

        lexicalScore: 0,

        semanticScore:
          semanticResult.score,

        hybridScore: 0,
      },
    );
  }

  return [...merged.values()]
    .map((result) => ({
      ...result,

      hybridScore:
        (
          result.lexicalScore *
            lexicalWeight +
          result.semanticScore *
            semanticWeight
        ) /
        (
          lexicalWeight +
          semanticWeight
        ),
    }))
    .sort((left, right) => {
      if (
        right.hybridScore !==
        left.hybridScore
      ) {
        return (
          right.hybridScore -
          left.hybridScore
        );
      }

      return left.chunk.id.localeCompare(
        right.chunk.id,
      );
    })
    .slice(0, finalLimit);
}
