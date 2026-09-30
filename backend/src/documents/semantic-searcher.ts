import type {
  DocumentChunk,
  SemanticDocumentIndex,
  SemanticSearchResult,
} from './types.js';

export function cosineSimilarity(
  left: number[],
  right: number[],
): number {
  if (
    left.length === 0 ||
    left.length !== right.length
  ) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (
    let index = 0;
    index < left.length;
    index += 1
  ) {
    const leftValue =
      left[index] ?? 0;

    const rightValue =
      right[index] ?? 0;

    dot +=
      leftValue *
      rightValue;

    leftMagnitude +=
      leftValue *
      leftValue;

    rightMagnitude +=
      rightValue *
      rightValue;
  }

  if (
    leftMagnitude === 0 ||
    rightMagnitude === 0
  ) {
    return 0;
  }

  return (
    dot /
    (
      Math.sqrt(leftMagnitude) *
      Math.sqrt(rightMagnitude)
    )
  );
}

export function searchDocumentsSemantic(
  queryEmbedding: number[],
  chunks: DocumentChunk[],
  semanticIndex: SemanticDocumentIndex,
  limit = 8,
  minimumScore = 0.55,
): SemanticSearchResult[] {
  if (
    queryEmbedding.length !==
    semanticIndex.dimensions
  ) {
    throw new Error(
      `Query embedding has ${queryEmbedding.length} dimensions; expected ${semanticIndex.dimensions}.`,
    );
  }

  const chunksById =
    new Map(
      chunks.map(
        (chunk) => [
          chunk.id,
          chunk,
        ],
      ),
    );

  return semanticIndex.entries
    .map((entry) => {
      const chunk =
        chunksById.get(
          entry.chunkId,
        );

      if (!chunk) {
        return null;
      }

      if (
        entry.embedding.length !==
        semanticIndex.dimensions
      ) {
        throw new Error(
          `Embedding dimensions are invalid for chunk ${entry.chunkId}.`,
        );
      }

      return {
        chunk,
        score:
          cosineSimilarity(
            queryEmbedding,
            entry.embedding,
          ),
      };
    })
    .filter(
      (
        result,
      ): result is SemanticSearchResult =>
        result !== null &&
        result.score >=
          minimumScore,
    )
    .sort(
      (left, right) =>
        right.score -
        left.score,
    )
    .slice(0, limit);
}
