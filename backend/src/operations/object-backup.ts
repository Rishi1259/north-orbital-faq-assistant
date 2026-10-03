import 'dotenv/config';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import path from 'node:path';
import { loadEnvironment } from '../config.js';
async function main() {
  const config = loadEnvironment();
  const client = new S3Client({ endpoint: config.OBJECT_STORAGE_ENDPOINT, region: config.OBJECT_STORAGE_REGION,
    forcePathStyle: config.OBJECT_STORAGE_FORCE_PATH_STYLE, credentials: config.OBJECT_STORAGE_ACCESS_KEY && config.OBJECT_STORAGE_SECRET_KEY ?
      { accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: config.OBJECT_STORAGE_SECRET_KEY } : undefined });
  const directory = path.resolve(process.argv[2] ?? '../backups/objects', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest: { key: string; file: string; size: number; sha256: string; contentType?: string }[] = [];
  let token: string | undefined;
  try {
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.OBJECT_STORAGE_BUCKET, ContinuationToken: token }));
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        // Never map untrusted object keys to filesystem paths.
        const file = `${manifest.length.toString().padStart(8, '0')}.object`;
        const response = await client.send(new GetObjectCommand({ Bucket: config.OBJECT_STORAGE_BUCKET, Key: object.Key, IfMatch: object.ETag }));
        if (!response.Body) throw new Error('Missing body.');
        const hash = createHash('sha256'); let size = 0;
        const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk); } });
        await pipeline(response.Body as NodeJS.ReadableStream, measure, createWriteStream(path.join(directory, file), { flags: 'wx', mode: 0o600 }));
        if (object.Size !== size) throw new Error('Object changed during backup.');
        manifest.push({ key: object.Key, file, size, sha256: hash.digest('hex'), contentType: response.ContentType });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: 1, objects: manifest }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`Object backup complete: ${manifest.length} objects, ${manifest.reduce((n, o) => n + o.size, 0)} bytes.`);
  } finally { client.destroy(); }
}
main().catch(() => { console.error('Object backup failed. Check private storage configuration; incomplete output must not be used for restore.'); process.exitCode = 1; });
