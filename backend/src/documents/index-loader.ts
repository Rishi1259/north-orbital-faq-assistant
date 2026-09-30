import {
  readFileSync,
} from 'node:fs';

import path from 'node:path';

import type {
  DocumentIndex,
} from './types.js';

export function loadDocumentIndex(): DocumentIndex {
  const repositoryRoot =
    path.resolve(
      process.cwd(),
      '..',
    );

  const indexPath =
    path.join(
      repositoryRoot,
      'documents',
      'generated',
      'document-index.json',
    );

  try {
    return JSON.parse(
      readFileSync(
        indexPath,
        'utf8',
      ),
    ) as DocumentIndex;
  } catch (error) {
    const code =
      (error as NodeJS.ErrnoException)
        .code;

    if (code === 'ENOENT') {
      return {
        generatedAt: '',
        chunks: [],
      };
    }

    throw error;
  }
}
