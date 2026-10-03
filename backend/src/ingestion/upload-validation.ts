import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import type { DocumentFormat } from '../documents/types.js';
import { DocumentError } from './errors.js';

export const MIME_TYPES = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } as const;
function unsupported(): DocumentError { return new DocumentError(415, 'UNSUPPORTED_FILE', 'Upload a valid PDF or DOCX file.'); }
export function sanitizeFilename(filename: string): string {
  return path.basename(filename.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim().slice(0, 200) || 'document';
}
// Inspect the ZIP central directory without unpacking user-controlled paths. Bound decompressed
// size before Mammoth sees the archive, and require the Word package content type.
async function validateDocx(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) { reject(unsupported()); return; }
      let total = 0;
      let expanded = 0;
      const names = new Set<string>();
      let wordType = false;
      let settled = false;
      const fail = () => { if (!settled) { settled = true; zip.close(); reject(unsupported()); } };
      zip.on('error', fail);
      zip.on('entry', (entry: yauzl.Entry) => {
        total += entry.uncompressedSize;
        if (names.has(entry.fileName) || names.size >= 10000 || total > 100 * 1024 * 1024 ||
          (entry.generalPurposeBitFlag & 1) !== 0 || entry.fileName.includes('\\') ||
          entry.fileName.split('/').includes('..') || entry.fileName.startsWith('/') ||
          entry.fileName.toLowerCase().endsWith('vbaproject.bin')) { fail(); return; }
        names.add(entry.fileName);
        const contentTypes = entry.fileName === '[Content_Types].xml';
        if (contentTypes && entry.uncompressedSize > 1024 * 1024) { fail(); return; }
        // Stream every entry through bounded decompression. Central-directory sizes alone
        // are attacker-controlled and must not authorize unbounded extraction in Mammoth.
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(); return; }
          const parts: Buffer[] = [];
          let entryBytes = 0;
          stream.on('error', fail);
          stream.on('data', (part: Buffer) => {
            expanded += part.length; entryBytes += part.length;
            if (expanded > 100 * 1024 * 1024 || entryBytes > entry.uncompressedSize ||
                (contentTypes && entryBytes > 1024 * 1024)) { stream.destroy(); fail(); return; }
            if (contentTypes) parts.push(part);
          });
          stream.on('end', () => {
            if (settled) return;
            if (entryBytes !== entry.uncompressedSize) { fail(); return; }
            if (contentTypes) wordType = Buffer.concat(parts).toString('utf8').includes(`${MIME_TYPES.docx.replace('.document', '.document.main')}+xml`);
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        if (wordType && names.has('word/document.xml') && names.has('_rels/.rels')) resolve();
        else reject(unsupported());
      });
      zip.readEntry();
    });
  });
}
export async function validateUpload(filePath: string, originalFilename: string, maxBytes: number) {
  if (/[\\/\u0000]/.test(originalFilename) || /^[a-z]:/i.test(originalFilename) || originalFilename.includes('..')) throw unsupported();
  const size = (await stat(filePath)).size;
  if (size > maxBytes) throw new DocumentError(413, 'UPLOAD_TOO_LARGE', 'Uploaded file exceeds the size limit.');
  if (!size) throw unsupported();
  const file = await open(filePath, 'r');
  const header = Buffer.alloc(8);
  try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
  let format: DocumentFormat;
  if (/^%PDF-[12]\.\d/.test(header.toString('ascii'))) format = 'pdf';
  else if (header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    await validateDocx(filePath);
    format = 'docx';
  } else throw unsupported();
  const filename = sanitizeFilename(originalFilename);
  if (path.extname(filename).toLowerCase() !== `.${format}`) throw unsupported();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { format, filename, size, checksum: hash.digest('hex'), mimeType: MIME_TYPES[format] };
}
