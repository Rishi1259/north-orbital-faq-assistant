import path from 'node:path';
import {
  fileURLToPath,
} from 'node:url';

import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  chunkDocuments,
} from '../src/documents/chunker.js';

import {
  extractDocx,
} from '../src/documents/docx-extractor.js';

import {
  extractPdf,
} from '../src/documents/pdf-extractor.js';

import {
  searchDocuments,
} from '../src/documents/searcher.js';

const repositoryRoot =
  fileURLToPath(
    new URL(
      '../../',
      import.meta.url,
    ),
  );

async function createChunks() {
  const pdf =
    await extractPdf(
      path.join(
        repositoryRoot,
        'documents',
        'samples',
        'north-orbital-digital-access-guide.pdf',
      ),
      'documents/samples/north-orbital-digital-access-guide.pdf',
    );

  const docx =
    await extractDocx(
      path.join(
        repositoryRoot,
        'documents',
        'samples',
        'north-orbital-volunteer-handbook.docx',
      ),
      'documents/samples/north-orbital-volunteer-handbook.docx',
    );

  return chunkDocuments([
    pdf,
    docx,
  ]);
}

describe(
  'document chunking and search',
  () => {
    it('preserves PDF page metadata', async () => {
      const chunks =
        await createChunks();

      const results =
        searchDocuments(
          'How long can I reserve a lab workstation?',
          chunks,
        );

      expect(
        results[0]?.chunk.page,
      ).toBe(1);

      expect(
        results[0]?.chunk.text,
      ).toContain(
        '90 minutes',
      );
    });

    it('retrieves DOCX orientation section', async () => {
      const chunks =
        await createChunks();

      const results =
        searchDocuments(
          'How long is volunteer orientation?',
          chunks,
        );

      expect(
        results[0]?.chunk.section,
      ).toBe(
        'Orientation',
      );

      expect(
        results[0]?.chunk.text,
      ).toContain(
        '60-minute orientation',
      );
    });

    it('retrieves PDF technical support information', async () => {
      const chunks =
        await createChunks();

      const results =
        searchDocuments(
          'Can staff repair my personal computer?',
          chunks,
        );

      expect(
        results[0]?.chunk.page,
      ).toBe(2);

      expect(
        results[0]?.chunk.text,
      ).toContain(
        'do not repair personal computers',
      );
    });

    it('retrieves DOCX shift cancellation information', async () => {
      const chunks =
        await createChunks();

      const results =
        searchDocuments(
          'When should I cancel a volunteer shift?',
          chunks,
        );

      expect(
        results[0]?.chunk.section,
      ).toBe(
        'Shift changes',
      );

      expect(
        results[0]?.chunk.text,
      ).toContain(
        '12 hours',
      );
    });

    it('returns no result for unrelated content', async () => {
      const chunks =
        await createChunks();

      const results =
        searchDocuments(
          'What is the weather forecast for tomorrow?',
          chunks,
        );

      expect(results).toEqual(
        [],
      );
    });
  },
);

it('does not match bicycle repair to computer repair', async () => {
  const chunks =
    await createChunks();

  const results =
    searchDocuments(
      'Do you repair bicycles?',
      chunks,
    );

  expect(results).toEqual([]);
});
