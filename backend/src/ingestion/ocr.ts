import { spawn } from 'node:child_process';
import { IngestionError } from './errors.js';

export interface OcrProvider { process(inputPath: string, outputPath: string): Promise<void> }
export class CommandOcrProvider implements OcrProvider {
  constructor(private readonly command: string, private readonly timeoutMs: number) {}
  async process(inputPath: string, outputPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, ['--force-ocr', '--output-type', 'pdf', '--optimize', '0',
        '--jobs', '1', '--quiet', inputPath, outputPath], {
        shell: false, stdio: 'ignore', detached: process.platform !== 'win32',
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // OCRmyPDF launches Tesseract/Ghostscript; kill its process group on timeout too.
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* Process already exited. */ }
      }, this.timeoutMs);
      child.once('error', () => { clearTimeout(timer); reject(new IngestionError('ocr')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (code === 0 && !timedOut) resolve(); else reject(new IngestionError('ocr'));
      });
    });
  }
}
