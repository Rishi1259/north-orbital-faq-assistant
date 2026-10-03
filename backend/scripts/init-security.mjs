import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const target = new URL('../../.env.security.local', import.meta.url);
try {
  await writeFile(target, `# Local HTTP development only. Do not deploy this file.\nRATE_LIMIT_HASH_SECRET=${randomBytes(32).toString('hex')}\nMETRICS_TOKEN=${randomBytes(32).toString('hex')}\nMETRICS_ENABLED=true\nADMIN_APP_ORIGIN=http://localhost:4200\nLOCAL_HTTP_DEVELOPMENT=true\nSESSION_COOKIE_SECURE=false\nPUBLIC_CHAT_ALLOW_MISSING_ORIGIN=false\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created private local security configuration.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('Existing local security configuration preserved.');
  else { console.error('Could not create local security configuration.'); process.exitCode = 1; }
}
