import path from 'node:path';
import {
  fileURLToPath,
} from 'node:url';

import {
  describe,
  expect,
  it,
} from 'vitest';

import { extractDocx } from '../src/documents/docx-extractor.js';
import { extractPdf } from '../src/documents/pdf-extractor.js';

const repositoryRoot =
  fileURLToPath(
    new URL('../../', import.meta.url),
  );

describe('document extraction', () => {
  it('extracts PDF text with page metadata', async () => {
    const filePath = path.join(
      repositoryRoot,
      'documents',
      'samples',
      'north-orbital-digital-access-guide.pdf',
    );

    const document =
      await extractPdf(
        filePath,
        'documents/samples/north-orbital-digital-access-guide.pdf',
      );

    expect(document.format).toBe(
      'pdf',
    );

    expect(
      document.blocks.length,
    ).toBeGreaterThanOrEqual(2);

    expect(
      document.blocks.some(
        (block) =>
          block.page === 1,
      ),
    ).toBe(true);

    expect(
      document.blocks
        .map((block) => block.text)
        .join(' '),
    ).toContain('90 minutes');
  });

  it('extracts DOCX text with section metadata', async () => {
    const filePath = path.join(
      repositoryRoot,
      'documents',
      'samples',
      'north-orbital-volunteer-handbook.docx',
    );

    const document =
      await extractDocx(
        filePath,
        'documents/samples/north-orbital-volunteer-handbook.docx',
      );

    expect(document.format).toBe(
      'docx',
    );

    expect(
      document.blocks.some(
        (block) =>
          block.section ===
          'Orientation',
      ),
    ).toBe(true);

    expect(
      document.blocks
        .map((block) => block.text)
        .join(' '),
    ).toContain(
      '60-minute orientation',
    );
  });
});
