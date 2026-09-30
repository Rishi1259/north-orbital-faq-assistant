import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  buildSemanticIndex,
  embeddingTextForChunk,
} from '../src/documents/semantic-indexer.js';

import type {
  DocumentChunk,
} from '../src/documents/types.js';

const chunks: DocumentChunk[] = [
  {
    id: 'DOC-TEST-B0001-C001',
    documentId: 'DOC-TEST',
    documentTitle: 'Test Guide',
    fileName: 'test.pdf',
    sourcePath:
      'documents/samples/test.pdf',
    format: 'pdf',
    blockId: 'DOC-TEST-B0001',
    page: 3,
    text:
      'Workstations may be reserved for ninety minutes.',
  },

  {
    id: 'DOC-TEST-B0002-C001',
    documentId: 'DOC-TEST',
    documentTitle: 'Test Guide',
    fileName: 'test.pdf',
    sourcePath:
      'documents/samples/test.pdf',
    format: 'pdf',
    blockId: 'DOC-TEST-B0002',
    page: 4,
    text:
      'Printing is available for registered participants.',
  },
];

describe(
  'semantic document indexer',
  () => {
    it('includes document metadata in embedding text', () => {
      const text =
        embeddingTextForChunk(
          chunks[0]!,
        );

      expect(text).toContain(
        'Document: Test Guide',
      );

      expect(text).toContain(
        'Page 3',
      );

      expect(text).toContain(
        'ninety minutes',
      );
    });

    it('creates one embedding per chunk', async () => {
      const embed =
        vi.fn(
          async (
            inputs: string[],
          ) =>
            inputs.map(
              (
                _input,
                index,
              ) => [
                index + 0.1,
                index + 0.2,
                index + 0.3,
              ],
            ),
        );

      const index =
        await buildSemanticIndex(
          chunks,
          { embed },
          {
            model:
              'test-model',
            batchSize: 8,
          },
        );

      expect(
        index.entries,
      ).toHaveLength(2);

      expect(
        index.dimensions,
      ).toBe(3);

      expect(
        index.entries[0],
      ).toEqual({
        chunkId:
          'DOC-TEST-B0001-C001',

        embedding: [
          0.1,
          0.2,
          0.3,
        ],
      });
    });

    it('batches embedding requests', async () => {
      const embed =
        vi.fn(
          async (
            inputs: string[],
          ) =>
            inputs.map(
              () => [
                0.1,
                0.2,
              ],
            ),
        );

      await buildSemanticIndex(
        chunks,
        { embed },
        {
          model:
            'test-model',
          batchSize: 1,
        },
      );

      expect(embed).toHaveBeenCalledTimes(
        2,
      );
    });
  },
);
