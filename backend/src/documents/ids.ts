import path from 'node:path';

export function makeDocumentId(
  fileName: string,
): string {
  const stem = path.basename(
    fileName,
    path.extname(fileName),
  );

  const slug = stem
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `DOC-${slug}`;
}

export function makeBlockId(
  documentId: string,
  index: number,
): string {
  return `${documentId}-B${String(index).padStart(4, '0')}`;
}
