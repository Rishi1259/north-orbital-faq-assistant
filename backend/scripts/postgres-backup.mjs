import { spawn } from 'node:child_process';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
function command(args, input, output) {
  const child = spawn('docker', ['compose', 'exec', '-T', 'postgres', ...args], { cwd: root, stdio: ['pipe','pipe','pipe'] });
  // Never print raw pg errors, which may include data or connection credentials.
  child.stderr.resume();
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('PostgreSQL operation failed.'))); });
  const stdin = input ? pipeline(input, child.stdin) : (child.stdin.end(), Promise.resolve());
  const stdout = output ? pipeline(child.stdout, output) : (child.stdout.resume(), Promise.resolve());
  return Promise.all([done, stdin, stdout]);
}
const directory = path.join(root, 'backups/postgres');
await mkdir(directory, { recursive: true, mode: 0o700 });
const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.dump`);
let temporary;
try {
  await command(['pg_dump','-U','north_orbital','-d','north_orbital','-Fc','--no-owner','--no-acl'], null, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  if ((await stat(file)).size === 0) throw new Error('Empty backup.');
  console.log(`Backup created: ${path.relative(root, file)}`);
  if (process.argv.includes('--verify')) {
    temporary = `north_orbital_restore_check_${randomBytes(8).toString('hex')}`;
    await command(['createdb','-U','north_orbital',temporary]);
    await command(['pg_restore','-U','north_orbital','-d',temporary,'--no-owner','--no-acl','--exit-on-error'], createReadStream(file));
    const verify = `DO $$ BEGIN
      IF (SELECT count(*) FROM pgmigrations) < 5 THEN RAISE EXCEPTION 'Missing migrations'; END IF;
      IF to_regclass('auth_sessions') IS NULL OR to_regclass('audit_events') IS NULL OR to_regclass('document_embeddings') IS NULL
        OR to_regclass('chatbot_allowed_origins') IS NULL THEN RAISE EXCEPTION 'Missing tables'; END IF;
      IF (SELECT count(*) FROM organizations) < 1 OR (SELECT count(*) FROM chatbots) < 1 THEN RAISE EXCEPTION 'Missing tenant data'; END IF;
      IF EXISTS(SELECT 1 FROM documents WHERE status='ready' AND NOT EXISTS(SELECT 1 FROM document_chunks c WHERE c.document_id=documents.id))
        THEN RAISE EXCEPTION 'Ready document has no chunks'; END IF;
    END $$;`;
    await command(['psql','-U','north_orbital','-d',temporary,'-v','ON_ERROR_STOP=1','-c',verify]);
    console.log('Temporary restore: migrations, security tables, tenant rows and ready-document chunks verified.');
  }
} catch { console.error('Backup/restore verification failed. Active database was not restored or dropped.'); process.exitCode = 1; }
finally {
  if (temporary && /^north_orbital_restore_check_[a-f0-9]{16}$/.test(temporary)) {
    try { await command(['dropdb','-U','north_orbital','--if-exists',temporary]); console.log('Temporary restore database removed.'); }
    catch { console.error(`Temporary restore database requires cleanup: ${temporary}`); process.exitCode = 1; }
  }
}
