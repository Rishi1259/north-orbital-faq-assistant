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

it('rejects a PDF above the page limit before extracting its text', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(path.join(tmpdir(), 'pdf-page-limit-'));
  try {
    const pdf = await PDFDocument.create();
    for (let n = 0; n < 1001; n++) pdf.addPage([10, 10]);
    const filename = path.join(directory, 'oversized.pdf');
    await writeFile(filename, await pdf.save());
    await expect(extractPdf(filename, 'test')).rejects.toThrow('PDF page limit exceeded.');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
