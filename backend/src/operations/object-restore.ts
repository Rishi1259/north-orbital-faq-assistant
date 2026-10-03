import 'dotenv/config';
import { parseArgs } from 'node:util';
import { S3Client, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { loadEnvironment } from '../config.js';
async function main() {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, bucket: { type: 'string' } } });
  const config = loadEnvironment();
  if (!values.directory || !values.bucket || values.bucket === config.OBJECT_STORAGE_BUCKET) throw new Error('Use a separate empty restore bucket.');
  const directory = path.resolve(values.directory);
  const manifest = z.object({ version: z.literal(1), objects: z.array(z.object({ key: z.string().min(1).max(1024),
    file: z.string().regex(/^\d{8}\.object$/), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), contentType: z.string().optional() })) }).parse(JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8')));
  const client = new S3Client({ endpoint: config.OBJECT_STORAGE_ENDPOINT, region: config.OBJECT_STORAGE_REGION,
    forcePathStyle: config.OBJECT_STORAGE_FORCE_PATH_STYLE, credentials: config.OBJECT_STORAGE_ACCESS_KEY && config.OBJECT_STORAGE_SECRET_KEY ?
      { accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: config.OBJECT_STORAGE_SECRET_KEY } : undefined });
  try {
    const existing = await client.send(new ListObjectsV2Command({ Bucket: values.bucket, MaxKeys: 1 }));
    if (existing.Contents?.length) throw new Error('Restore bucket must be empty.');
    for (const object of manifest.objects) {
      const filename = path.join(directory, object.file), info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== object.size) throw new Error('Invalid backup file.');
      const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk);
      if (hash.digest('hex') !== object.sha256) throw new Error('Backup checksum mismatch.');
    }
    for (const object of manifest.objects) await client.send(new PutObjectCommand({ Bucket: values.bucket, Key: object.key,
      Body: createReadStream(path.join(directory, object.file)), ContentLength: object.size, ContentType: object.contentType,
      IfNoneMatch: '*' }));
    console.log(`Restored ${manifest.objects.length} verified objects into the separate restore bucket.`);
  } finally { client.destroy(); }
}
main().catch(() => { console.error('Object restore failed. Check the manifest, checksums and separate empty target bucket.'); process.exitCode = 1; });
