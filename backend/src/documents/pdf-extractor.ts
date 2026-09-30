import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PDFParse } from 'pdf-parse';

import {
  makeBlockId,
  makeDocumentId,
} from './ids.js';

import type {
  ExtractedDocument,
} from './types.js';

export async function extractPdf(
  filePath: string,
  sourcePath: string,
): Promise<ExtractedDocument> {
  const fileName = path.basename(filePath);
  const documentId = makeDocumentId(fileName);

  const data = await readFile(filePath);

  const parser = new PDFParse({
    data,
  });

  try {
    const result = await parser.getText();

    const blocks = result.pages
      .map((page, index) => ({
        id: makeBlockId(
          documentId,
          index + 1,
        ),
        text: page.text
          .replace(/\s+/g, ' ')
          .trim(),
        page: page.num,
      }))
      .filter(
        (block) => block.text.length > 0,
      );

    const extractedTitle =
      result.pages[0]?.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

    return {
      id: documentId,
      fileName,
      sourcePath,
      format: 'pdf',
      title:
        extractedTitle ??
        path.basename(
          fileName,
          path.extname(fileName),
        ),
      blocks,
      warnings: [],
    };
  } finally {
    await parser.destroy();
  }
}
