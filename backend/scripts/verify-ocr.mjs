// Opt-in real OCR check. Requires a built backend plus OCRmyPDF, Poppler,
// Python 3 and Pillow (all provided by the worker image).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdf } from '../dist/documents/pdf-extractor.js';
import { pdfTextQuality } from '../dist/ingestion/quality.js';
import { CommandOcrProvider } from '../dist/ingestion/ocr.js';

const exec = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), 'ocr-verification-'));
try {
  const sample = fileURLToPath(new URL('../../documents/samples/north-orbital-digital-access-guide.pdf', import.meta.url));
  const raster = path.join(directory, 'page');
  const scan = path.join(directory, 'scan.pdf');
  const output = path.join(directory, 'ocr.pdf');
  await exec('pdftoppm', ['-f', '1', '-singlefile', '-r', '150', '-png', sample, raster]);
  await exec('python3', ['-c', 'from PIL import Image; import sys; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], resolution=150)', `${raster}.png`, scan]);
  assert.equal(pdfTextQuality(await extractPdf(scan, 'test')).usable, false);
  await new CommandOcrProvider(process.env.OCR_COMMAND ?? 'ocrmypdf', 180000).process(scan, output);
  const extracted = await extractPdf(output, 'test');
  assert.equal(pdfTextQuality(extracted).usable, true);
  assert.equal(extracted.pageCount, 1);
  if (process.env.OCR_SCAN_OUTPUT) await copyFile(scan, process.env.OCR_SCAN_OUTPUT);
  console.log('OCR integration passed: image-only PDF recovered useful text with page metadata.');
} catch {
  console.error('OCR integration failed. Check OCRmyPDF, Poppler, Python/Pillow and the backend build.');
  process.exitCode = 1;
} finally { await rm(directory, { recursive: true, force: true }); }
