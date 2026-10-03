import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SecurityRepository } from '../../src/security/repository.js';
import { PublicChatbotRepository } from '../../src/public/repository.js';
import { loadSecurityConfig } from '../../src/security/config.js';
import { hashToken, randomToken } from '../../src/security/crypto.js';
import { PostgresRetrievalRepository } from '../../src/rag/repository.js';
import { OrganizationRepository } from '../../src/organizations/organization-repository.js';
import { OrganizationService } from '../../src/organizations/organization-service.js';
import { ChatbotRepository } from '../../src/chatbots/chatbot-repository.js';
import { ChatbotService } from '../../src/chatbots/chatbot-service.js';
const schema = `security_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
const config = loadSecurityConfig({ NODE_ENV: 'test', RATE_LIMIT_HASH_SECRET: randomToken(), SESSION_COOKIE_SECURE: 'false', LOCAL_HTTP_DEVELOPMENT: 'true' });
const security = new SecurityRepository(pool, config), bots = new PublicChatbotRepository(pool, security);
const password = 'Long integration passphrase';
const emailA = 'owner-a@example.test', emailB = 'owner-b@example.test';
let orgA: string, orgB: string, botA: string, botB: string, botOther: string, sourceA: string, sourceB: string, sourceOther: string, userA: string;
let cookie: string, csrf: string, publicId: string;
const organizationRepository = new OrganizationRepository(pool);
const app = createApp({ security, securityConfig: config, publicChatbots: bots,
  organizationService: new OrganizationService(organizationRepository), chatbotService: new ChatbotService(organizationRepository, new ChatbotRepository(pool)),
  retrievalRepository: new PostgresRetrievalRepository(pool), embeddingProvider: { embed: async () => { throw new Error('offline'); } },
  provider: { generateAnswer: async () => ({ canAnswer: true, answer: 'Cancel at least 12 hours in advance.', sourceIds: ['S1'] }) },
});
const base = (org = orgA, bot = botA) => `/api/organizations/${org}/chatbots/${bot}`;
const publicBase = (id = publicId) => `/api/public/chatbots/${id}`;
const origin = 'http://localhost:4200';
function auth(method: 'get' | 'post' | 'put', url: string) { return request(app)[method](url).set('Cookie', cookie).set('X-CSRF-Token', csrf); }
async function login(email = emailA, inputPassword = password) { return request(app).post('/api/auth/login').set('Origin', origin).send({ email, password: inputPassword }); }
async function tenant(organizationId?: string) {
  const org = organizationId ?? (await pool.query('INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id', ['Fixture', randomUUID()])).rows[0].id;
  const bot = (await pool.query('INSERT INTO chatbots(organization_id,name) VALUES($1,$2) RETURNING id', [org, 'Fixture'])).rows[0].id;
  const doc = (await pool.query(`INSERT INTO documents(organization_id,chatbot_id,title,original_filename,mime_type,status,storage_key)
    VALUES($1,$2,'Handbook','handbook.pdf','application/pdf','ready','DO-NOT-EXPOSE') RETURNING id`, [org, bot])).rows[0].id;
  const source = (await pool.query(`INSERT INTO document_chunks(organization_id,chatbot_id,document_id,chunk_index,content)
    VALUES($1,$2,$3,0,'Volunteers should cancel at least 12 hours in advance.') RETURNING id`, [org, bot, doc])).rows[0].id;
  return { org, bot, source };
}
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runner({ advisoryLockMode: 'wait', databaseUrl: process.env.DATABASE_URL, dir: fileURLToPath(new URL('../../migrations', import.meta.url)), direction: 'up',
    migrationsTable: 'pgmigrations', migrationsSchema: schema, schema: [schema, 'public'], logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const a = await tenant(), b = await tenant(), c = await tenant(a.org);
  orgA = a.org; orgB = b.org; botA = a.bot; botB = b.bot; botOther = c.bot; sourceA = a.source; sourceB = b.source; sourceOther = c.source;
  userA = (await security.bootstrap(emailA, password, orgA)).id;
  await security.bootstrap(emailB, password, orgB);
  const result = await login(); expect(result.status).toBe(200); cookie = result.headers['set-cookie'][0].split(';')[0]; csrf = result.body.csrfToken;
}, 30000);
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });

describe('real authentication, authorization and public boundary', () => {
  it('stores only hashes, returns safe user data and validates CSRF/session expiry/revocation', async () => {
    const me = await auth('get', '/api/auth/me').expect(200);
    expect(Object.keys(me.body.user).sort()).toEqual(['email','id']);
    const users = (await pool.query('SELECT password_hash FROM users')).rows;
    expect(users.every(u => u.password_hash.startsWith('$argon2id$'))).toBe(true);
    const sessions = (await pool.query('SELECT * FROM auth_sessions')).rows;
    expect(JSON.stringify(sessions)).not.toContain(cookie.split('=')[1]); expect(JSON.stringify(sessions)).not.toContain(csrf);
    await request(app).post(`${base()}/public-id/rotate`).set('Cookie', cookie).expect(403);
    await request(app).post(`${base()}/public-id/rotate`).set('Cookie', cookie).set('X-CSRF-Token', randomToken()).expect(403);
    const second = await login(); expect(second.status).toBe(200);
    expect(second.headers['set-cookie'][0]).toContain('HttpOnly'); expect(second.headers['set-cookie'][0]).toContain('SameSite=Lax');
    const raw = second.headers['set-cookie'][0].split(';')[0]; expect(raw).not.toBe(cookie);
    await pool.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hashToken(raw.split('=')[1])]);
    await request(app).get('/api/auth/me').set('Cookie', raw).expect(401);
    await request(app).post('/api/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf).expect(204);
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);
    const fresh = await login(); cookie = fresh.headers['set-cookie'][0].split(';')[0]; csrf = fresh.body.csrfToken;
  });
  it('rejects every cross-tenant route before document parsing or mutation', async () => {
    for (const [method, url] of [
      ['get',base(orgB,botB)], ['post',`${base(orgB,botB)}/chat`], ['put',`${base(orgB,botB)}/branding`],
      ['post',`${base(orgB,botB)}/documents`], ['post',`${base(orgB,botB)}/documents/${randomUUID()}/retry`],
      ['get',`${base(orgB,botB)}/document-sources/${sourceB}`], ['put',`${base(orgB,botB)}/public-access`],
      ['put',`${base(orgB,botB)}/allowed-origins`], ['post',`${base(orgB,botB)}/public-id/rotate`],
      ['get',`/api/organizations/${orgB}/audit-events`],
    ] as const) await auth(method, url).send({}).expect(404);
    await auth('get', base(orgA, botB)).expect(404);
    await auth('get', `${base()}/document-sources/${sourceB}`).expect(404);
  });
  it('creates organizations and ownership atomically; enforces member/admin role boundaries', async () => {
    const created = await auth('post','/api/organizations').send({ name: 'Owned', slug: randomUUID() }).expect(201);
    expect(await security.role(userA, created.body.organization.id)).toBe('owner');
    await pool.query("UPDATE organization_memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [orgA, userA]);
    await auth('get', base()).expect(200);
    await auth('post',`${base()}/chat`).send({ message: 'When can volunteers cancel?' }).expect(200);
    await auth('put',`${base()}/public-access`).send({ enabled: true }).expect(403);
    await auth('post',`${base()}/public-id/rotate`).expect(403);
    await auth('get',`/api/organizations/${orgA}/audit-events`).expect(403);
    await pool.query("UPDATE organization_memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [orgA, userA]);
    await auth('get',`/api/organizations/${orgA}/audit-events`).expect(200);
  });
  it('starts private, validates settings and origins, and exposes only safe public config', async () => {
    const settings = await auth('get',`${base()}/public-settings`).expect(200); publicId = settings.body.publicId;
    expect(publicId).toMatch(/^pub_[a-f0-9]{48}$/); expect(settings.body.publicEnabled).toBe(false);
    await request(app).get(`${publicBase()}/config`).set('Origin', origin).expect(404);
    await auth('put',`${base()}/public-access`).send({ enabled: true }).expect(200);
    await auth('put',`${base()}/allowed-origins`).send({ origins: [origin, origin + '/'] }).expect(200);
    await auth('put',`${base()}/allowed-origins`).send({ origins: ['https://example.com/path'] }).expect(400);
    await auth('put',`${base()}/branding`).send({ displayName: '<script>text</script>', welcomeMessage: 'Welcome', accentColor: '#123ABC', launcherLabel: 'Ask', launcherPosition: 'bottom-left' }).expect(200);
    const response = await request(app).get(`${publicBase()}/config`).set('Origin', origin).expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['publicId','displayName','welcomeMessage','accentColor','launcherLabel','launcherPosition'].sort());
    expect(response.headers['access-control-allow-origin']).toBe(origin); expect(response.headers.vary).toContain('Origin');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    const mixedCase = await request(app).get(`/api/PUBLIC/chatbots/${publicId}/config`).set('Origin',origin).expect(200);
    expect(mixedCase.headers['access-control-allow-credentials']).toBeUndefined();
    for (const value of [orgA,botA,'storage','model','allowedOrigins','secret']) expect(response.text).not.toContain(value);
    for (const value of ['https://evil.example','null','https://localhost:4200','http://localhost:4200/path'])
      await request(app).get(`${publicBase()}/config`).set('Origin',value).expect(403);
    await request(app).get(`${publicBase()}/config`).expect(403);
    await request(app).options(`${publicBase()}/chat`).set('Origin',origin).expect(204);
    await request(app).options(`${publicBase()}/chat`).set('Origin','https://evil.example').expect(403);
    await request(app).get(`${publicBase('pub_fake')}/config`).set('Origin',origin).expect(404);
  });
  it('uses production RAG and ready-only scoped sources without internal routing', async () => {
    const result = await request(app).post(`${publicBase()}/chat`).set('Origin',origin).send({ message: 'When can volunteers cancel?' }).expect(200);
    expect(result.body.fallback).toBe(false); expect(result.body.sources[0].id).toBe(sourceA);
    expect(result.text).not.toContain(orgA); expect(result.text).not.toContain(botA);
    const source = await request(app).get(result.body.sources[0].path).set('Origin',origin).expect(200);
    expect(source.body.excerpt).toContain('12 hours'); expect(source.text).not.toContain('DO-NOT-EXPOSE'); expect(source.body.documentId).toBeUndefined();
    for (const id of [sourceB,sourceOther,randomUUID(),'fake']) await request(app).get(`${publicBase()}/document-sources/${id}`).set('Origin',origin).expect(404);
    await pool.query("UPDATE documents SET status='failed' WHERE organization_id=$1 AND chatbot_id=$2",[orgA,botA]);
    await request(app).get(`${publicBase()}/document-sources/${sourceA}`).set('Origin',origin).expect(404);
    await pool.query("UPDATE documents SET status='ready' WHERE organization_id=$1 AND chatbot_id=$2",[orgA,botA]);
  });
  it('rotates immediately, retains sources/settings/origins, disables all public routes and audits safely', async () => {
    const old = publicId;
    const rotated = await auth('post',`${base()}/public-id/rotate`).expect(200); publicId = rotated.body.publicId;
    expect(publicId).not.toBe(old); expect(rotated.body.displayName).toBe('<script>text</script>');
    await request(app).get(`${publicBase(old)}/config`).set('Origin',origin).expect(404);
    await request(app).get(`${publicBase()}/config`).set('Origin',origin).expect(200);
    await request(app).get(`${publicBase()}/document-sources/${sourceA}`).set('Origin',origin).expect(200);
    await auth('put',`${base()}/public-access`).send({ enabled: false }).expect(200);
    for (const [method,suffix] of [['get','config'],['post','chat'],['get',`document-sources/${sourceA}`]] as const)
      await request(app)[method](`${publicBase()}/${suffix}`).set('Origin',origin).send({ message: 'test' }).expect(404);
    const audit = await auth('get',`/api/organizations/${orgA}/audit-events?limit=100`).expect(200);
    expect(audit.body.events.some((e: any) => e.action === 'chatbot.public_id.rotated')).toBe(true);
    for (const value of [password,csrf,cookie,'Volunteers should cancel','12 hours','prompt','embedding','authorization']) expect(audit.text).not.toContain(value);
    await expect(pool.query('UPDATE audit_events SET metadata=$1 WHERE organization_id=$2',[{},orgA])).rejects.toThrow('append-only');
    await auth('put',`${base()}/public-access`).send({ enabled: true }).expect(200);
  });
  it('rejects bad/unknown credentials consistently and limits login attempts', async () => {
    await pool.query('DELETE FROM rate_limit_windows');
    const wrong = await login(emailA,'incorrect'), unknown = await login('unknown@example.test','incorrect');
    expect(wrong.status).toBe(401); expect(unknown.body).toEqual(wrong.body);
    for (let n=0;n<3;n++) await login('unknown@example.test','incorrect');
    const limited = await login(); expect(limited.status).toBe(429); expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await request(app).post('/api/auth/login').set('Origin','https://evil.example').send({email:emailA,password}).expect(403);
  });
});
it('rate limits are atomic across concurrent clients, reset without sleeps and isolate tenants/users', async () => {
  const now = 1800000000000;
  const results = await Promise.all(Array.from({length:30},() => security.consume('parallel',[orgA,userA],5,60,now)));
  expect(results.filter(r=>r.allowed)).toHaveLength(5);
  expect((await security.consume('parallel',[orgA,userA],5,60,now+60000)).allowed).toBe(true);
  expect((await security.consume('parallel',[orgB,userA],5,60,now)).allowed).toBe(true);
  expect((await security.consume('parallel',[orgA,randomUUID()],5,60,now)).allowed).toBe(true);
  const rows = (await pool.query('SELECT key_hash FROM rate_limit_windows')).rows;
  expect(rows.every(r=>/^[a-f0-9]{64}$/.test(r.key_hash))).toBe(true);
});
it('public and upload HTTP limits return Retry-After and do not trust forwarded headers', async () => {
  await pool.query('DELETE FROM rate_limit_windows');
  const limitedConfig = { ...config, PUBLIC_CHAT_RATE_LIMIT: 1, UPLOAD_RATE_LIMIT: 1 };
  const server = createApp({ security, securityConfig: limitedConfig, publicChatbots: bots, provider: {} as never });
  await request(server).post(`${publicBase()}/chat`).set('Origin',origin).send({message:'test'}).expect(503);
  const blocked = await request(server).post(`${publicBase()}/chat`).set('Origin',origin).set('X-Forwarded-For','8.8.8.8').send({message:'test'}).expect(429);
  expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  await request(server).post(`${base()}/documents`).set('Cookie',cookie).set('X-CSRF-Token',csrf).expect(404);
  await request(server).post(`${base()}/documents`).set('Cookie',cookie).set('X-CSRF-Token',csrf).expect(429);
});
it('cleans expired sessions and windows without deleting valid sessions', async () => {
  await pool.query("UPDATE rate_limit_windows SET expires_at=now()-interval '1 second'");
  await security.cleanup(); expect((await pool.query('SELECT * FROM rate_limit_windows')).rowCount).toBe(0);
  await auth('get','/api/auth/me').expect(200);
});
