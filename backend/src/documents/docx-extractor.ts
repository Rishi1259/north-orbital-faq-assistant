import path from 'node:path';

import { load } from 'cheerio';
import mammoth from 'mammoth';

import {
  makeBlockId,
  makeDocumentId,
} from './ids.js';

import type {
  ExtractedBlock,
  ExtractedDocument,
} from './types.js';

export async function extractDocx(
  filePath: string,
  sourcePath: string,
): Promise<ExtractedDocument> {
  const fileName = path.basename(filePath);
  const documentId = makeDocumentId(fileName);

  const result =
    await mammoth.convertToHtml(
      {
        path: filePath,
      },
      {
        includeEmbeddedStyleMap: false,
        externalFileAccess: false,
      },
    );

  if (result.value.length > 10_000_000) throw new Error('DOCX extraction limit exceeded.');
  const $ = load(result.value);

  const blocks: ExtractedBlock[] = [];

  const extractedTitle =
    $('h1, h2, h3, h4, h5, h6, p')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();

  let currentSection = 'Document body';
  let blockNumber = 0;

  $(
    'h1, h2, h3, h4, h5, h6, p',
  ).each((_index, element) => {
    const tagName =
      element.tagName.toLowerCase();

    const text = $(element)
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) {
      return;
    }

    if (/^h[1-6]$/.test(tagName)) {
      currentSection = text;
      return;
    }

    blockNumber += 1;

    blocks.push({
      id: makeBlockId(
        documentId,
        blockNumber,
      ),
      text,
      section: currentSection,
    });
  });

  if (blocks.reduce((size, block) => size + block.text.length, 0) > 5_000_000) throw new Error('Document text limit exceeded.');

  return {
    id: documentId,
    fileName,
    sourcePath,
    format: 'docx',
    title:
      extractedTitle ||
      path.basename(
        fileName,
        path.extname(fileName),
      ),
    blocks,
    warnings: result.messages.map(
      (message) => message.message,
    ),
  };
}
