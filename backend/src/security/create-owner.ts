import 'dotenv/config';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { loadSecurityConfig } from './config.js';
import { SecurityRepository } from './repository.js';

async function main() {
  const { values } = parseArgs({ options: { email: { type: 'string' }, organization: { type: 'string' } }, strict: true });
  if (!values.email || !values.organization || !process.env.DATABASE_URL || process.stdin.isTTY) {
    throw new Error('Use --email and --organization with DATABASE_URL configured and password piped on stdin.');
  }
  let password = '';
  for await (const chunk of process.stdin) {
    password += chunk.toString(); if (Buffer.byteLength(password) > 1024) throw new Error('Invalid password input.');
  }
  password = password.replace(/\r?\n$/, '');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { await new SecurityRepository(pool, loadSecurityConfig()).bootstrap(values.email, password, values.organization); }
  finally { password = ''; await pool.end(); }
  process.stdout.write('Owner membership is ready.\n');
}
main().catch(() => { process.stderr.write('Owner bootstrap failed. Check input, existing account password, organization and database configuration.\n'); process.exitCode = 1; });
