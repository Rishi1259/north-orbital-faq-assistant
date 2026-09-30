import path from 'node:path';

import { extractDocx } from './docx-extractor.js';
import { extractPdf } from './pdf-extractor.js';

export async function extractDocument(
  filePath: string,
  sourcePath: string,
) {
  const extension =
    path.extname(filePath).toLowerCase();

  switch (extension) {
    case '.pdf':
      return extractPdf(
        filePath,
        sourcePath,
      );

    case '.docx':
      return extractDocx(
        filePath,
        sourcePath,
      );

    default:
      throw new Error(
        `Unsupported document format: ${extension}`,
      );
  }
}
