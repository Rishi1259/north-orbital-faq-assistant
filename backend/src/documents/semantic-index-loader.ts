import {
  readFileSync,
} from 'node:fs';

import path from 'node:path';

import type {
  SemanticDocumentIndex,
} from './types.js';

function semanticIndexPath(): string {
  return path.join(
    path.resolve(
      process.cwd(),
      '..',
    ),
    'documents',
    'generated',
    'semantic-index.json',
  );
}

export function loadSemanticDocumentIndex():
  SemanticDocumentIndex {
  return JSON.parse(
    readFileSync(
      semanticIndexPath(),
      'utf8',
    ),
  ) as SemanticDocumentIndex;
}

export function tryLoadSemanticDocumentIndex():
  SemanticDocumentIndex | null {
  try {
    return loadSemanticDocumentIndex();
  } catch (error) {
    const code =
      (error as NodeJS.ErrnoException)
        .code;

    if (code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}
