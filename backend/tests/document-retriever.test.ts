import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  retrieveDocumentChunks,
} from '../src/documents/document-retriever.js';

import type {
  DocumentChunk,
  SemanticDocumentIndex,
} from '../src/documents/types.js';

const chunk: DocumentChunk = {
  id:
    'DOC-TEST-B0001-C001',
  documentId:
    'DOC-TEST',
  documentTitle:
    'Test Guide',
  fileName:
    'test.pdf',
  sourcePath:
    'test.pdf',
  format:
    'pdf',
  blockId:
    'DOC-TEST-B0001',
  page: 1,
  text:
    'Registered participants may reserve a lab workstation for ninety minutes.',
};

const semanticIndex:
  SemanticDocumentIndex = {
    generatedAt:
      '2026-01-01T00:00:00.000Z',
    model:
      'test-model',
    dimensions: 2,
    entries: [
      {
        chunkId:
          chunk.id,
        embedding:
          [1, 0],
      },
    ],
  };

describe(
  'document retriever',
  () => {
    it('uses semantic retrieval for a paraphrase', async () => {
      const results =
        await retrieveDocumentChunks(
          'How much time can I use a computer?',
          [chunk],
          {
            semanticIndex,

            embeddingProvider: {
              embed:
                async () => [
                  [1, 0],
                ],
            },

            semanticMinimumScore:
              0.20,
          },
        );

      expect(
        results[0]?.id,
      ).toBe(chunk.id);
    });

    it('falls back to lexical retrieval when embeddings fail', async () => {
      const results =
        await retrieveDocumentChunks(
          'reserve lab workstation',
          [chunk],
          {
            semanticIndex,

            embeddingProvider: {
              embed:
                async () => {
                  throw new Error(
                    'Embedding service unavailable.',
                  );
                },
            },
          },
        );

      expect(
        results[0]?.id,
      ).toBe(chunk.id);
    });

    it('returns no result for unrelated content without semantic support', async () => {
      const results =
        await retrieveDocumentChunks(
          'capital of France',
          [chunk],
          {
            semanticIndex,

            embeddingProvider: {
              embed:
                async () => [
                  [0, 1],
                ],
            },

            semanticMinimumScore:
              0.20,
          },
        );

      expect(results).toEqual(
        [],
      );
    });
  },
);
