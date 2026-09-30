import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  searchDocumentsHybrid,
} from '../src/documents/hybrid-searcher.js';

import {
  cosineSimilarity,
  searchDocumentsSemantic,
} from '../src/documents/semantic-searcher.js';

import type {
  DocumentChunk,
  SemanticDocumentIndex,
} from '../src/documents/types.js';

const chunks: DocumentChunk[] = [
  {
    id: 'DOC-TEST-B0001-C001',
    documentId: 'DOC-TEST',
    documentTitle: 'Test Guide',
    fileName: 'test.pdf',
    sourcePath: 'test.pdf',
    format: 'pdf',
    blockId: 'DOC-TEST-B0001',
    page: 1,
    text:
      'Registered participants may reserve a lab workstation for ninety minutes.',
  },

  {
    id: 'DOC-TEST-B0002-C001',
    documentId: 'DOC-TEST',
    documentTitle: 'Test Guide',
    fileName: 'test.pdf',
    sourcePath: 'test.pdf',
    format: 'pdf',
    blockId: 'DOC-TEST-B0002',
    page: 2,
    text:
      'New volunteers complete orientation before their first shift.',
  },

  {
    id: 'DOC-TEST-B0003-C001',
    documentId: 'DOC-TEST',
    documentTitle: 'Test Guide',
    fileName: 'test.pdf',
    sourcePath: 'test.pdf',
    format: 'pdf',
    blockId: 'DOC-TEST-B0003',
    page: 3,
    text:
      'Printing is available for registered participants.',
  },
];

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
          'DOC-TEST-B0001-C001',
        embedding:
          [1, 0],
      },
      {
        chunkId:
          'DOC-TEST-B0002-C001',
        embedding:
          [0, 1],
      },
      {
        chunkId:
          'DOC-TEST-B0003-C001',
        embedding:
          [-1, 0],
      },
    ],
  };

describe(
  'semantic document search',
  () => {
    it('calculates cosine similarity', () => {
      expect(
        cosineSimilarity(
          [1, 0],
          [1, 0],
        ),
      ).toBeCloseTo(1);

      expect(
        cosineSimilarity(
          [1, 0],
          [0, 1],
        ),
      ).toBeCloseTo(0);
    });

    it('retrieves the closest semantic chunk', () => {
      const results =
        searchDocumentsSemantic(
          [0, 1],
          chunks,
          semanticIndex,
          3,
          0.55,
        );

      expect(
        results[0]?.chunk.id,
      ).toBe(
        'DOC-TEST-B0002-C001',
      );

      expect(
        results[0]?.score,
      ).toBeCloseTo(1);
    });
  },
);

describe(
  'hybrid document search',
  () => {
    it('retains strong lexical matches', async () => {
      const results =
        await searchDocumentsHybrid(
          'lab workstation reserve',
          chunks,
          semanticIndex,
          {
            embed:
              async () => [
                [0, 0],
              ],
          },
        );

      expect(
        results[0]?.chunk.id,
      ).toBe(
        'DOC-TEST-B0001-C001',
      );

      expect(
        results[0]?.lexicalScore,
      ).toBeGreaterThan(0);
    });

    it('finds semantic matches without shared wording', async () => {
      const results =
        await searchDocumentsHybrid(
          'Do helpers receive training before starting?',
          chunks,
          semanticIndex,
          {
            embed:
              async () => [
                [0, 1],
              ],
          },
        );

      expect(
        results[0]?.chunk.id,
      ).toBe(
        'DOC-TEST-B0002-C001',
      );

      expect(
        results[0]?.semanticScore,
      ).toBeCloseTo(1);
    });

    it('returns no semantic-only result below threshold', async () => {
      const results =
        await searchDocumentsHybrid(
          'What is the weather tomorrow?',
          [],
          {
            generatedAt:
              semanticIndex.generatedAt,
            model:
              semanticIndex.model,
            dimensions: 2,
            entries: [],
          },
          {
            embed:
              async () => [
                [1, 0],
              ],
          },
        );

      expect(
        results,
      ).toEqual([]);
    });
  },
);

it('allows a substantially stronger semantic match to beat weak lexical overlap', async () => {
  const results =
    await searchDocumentsHybrid(
      'printing participants',
      chunks,
      semanticIndex,
      {
        embed:
          async () => [
            [1, 0],
          ],
      },
      {
        semanticMinimumScore: 0.20,
      },
    );

  expect(
    results[0]?.chunk.id,
  ).toBe(
    'DOC-TEST-B0001-C001',
  );
});
