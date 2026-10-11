import 'dotenv/config';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {runner} from 'node-pg-migrate';
import request from 'supertest';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {createApp} from '../../src/app.js';
import {CommercialService} from '../../src/commercial/service.js';
import {CommercialDocuments} from '../../src/commercial/documents.js';
import {SecurityRepository} from '../../src/security/repository.js';
import {loadSecurityConfig} from '../../src/security/config.js';
import {randomToken} from '../../src/security/crypto.js';
import {PublicChatbotRepository} from '../../src/public/repository.js';
import {PostgresRetrievalRepository} from '../../src/rag/repository.js';
import {ChatbotRepository} from '../../src/chatbots/chatbot-repository.js';
import {ChatbotService} from '../../src/chatbots/chatbot-service.js';
import {OrganizationRepository} from '../../src/organizations/organization-repository.js';
import {OrganizationService} from '../../src/organizations/organization-service.js';
import {DocumentService} from '../../src/ingestion/document-service.js';
import {IngestionRepository} from '../../src/ingestion/repository.js';
import {storageKey,type ObjectStorage} from '../../src/storage/object-storage.js';
import {ModelProviderError} from '../../src/ai/errors.js';
import {PDFDocument} from 'pdf-lib';
const schema=`commercial_${randomUUID().replaceAll('-','')}`;
const admin=new Pool({connectionString:process.env.DATABASE_URL});
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema},public`,max:12});
const config=loadSecurityConfig({NODE_ENV:'test',RATE_LIMIT_HASH_SECRET:randomToken(),SESSION_COOKIE_SECURE:'false',LOCAL_HTTP_DEVELOPMENT:'true'});
const security=new SecurityRepository(pool,config),commercial=new CommercialService(pool),documents=new CommercialDocuments(commercial);
const orgs=new OrganizationRepository(pool),bots=new ChatbotRepository(pool),chatbots=new ChatbotService(orgs,bots);
const objects=new Set<string>();let failDelete=false,failPut=false,failModel=false;
const storage:ObjectStorage={put:async o=>{objects.add(storageKey(o));if(failPut)throw new Error('ambiguous secret provider error');},get:async()=>{},delete:async o=>{if(failDelete)throw new Error('storage secret');objects.delete(storageKey(o));}};
const ingestion=new IngestionRepository(pool);
const app=createApp({commercial,security,securityConfig:config,chatbotService:chatbots,organizationService:new OrganizationService(orgs),
  documentService:new DocumentService(chatbots,ingestion,storage,20971520,3,documents),publicChatbots:new PublicChatbotRepository(pool,security),
  retrievalRepository:new PostgresRetrievalRepository(pool),embeddingProvider:{embed:async()=>{throw new Error('offline');}},
  provider:{generateAnswer:async()=>{if(failModel)throw new ModelProviderError('unavailable','Unavailable');return {canAnswer:true,answer:'Cancel 12 hours ahead.',sourceIds:['S1']};}}});
let org:string,other:string,bot:string,user:string,cookie:string,csrf:string,publicId:string,legacy:string;
const origin='http://localhost:4200',password='Commercial integration password';
const base=()=>`/api/organizations/${org}`;
const auth=(method:'get'|'post'|'delete',url:string)=>request(app)[method](url).set('Cookie',cookie).set('X-CSRF-Token',csrf);
const audit=()=>({actorUserId:user,action:'test',targetType:'document'});
async function tenant(){return (await pool.query("INSERT INTO organizations(name,slug) VALUES('Commercial fixture',$1) RETURNING id",[randomUUID()])).rows[0].id;}
async function plan(sql:string){await pool.query(`UPDATE plans SET ${sql} WHERE code='beta'`);}
async function input(size=10){const i={organizationId:org,chatbotId:bot,documentId:randomUUID(),filename:'fixture.pdf',format:'pdf' as const,mimeType:'application/pdf',checksum:'a'.repeat(64),size,maxAttempts:3};return {...i,storageKey:storageKey(i)};}
async function upload(size=10){const i=await input(size);await documents.upload(i,storage,'unused');return i;}
async function ready(){const i=await upload();const job=await ingestion.claim('commercial-test');expect(job?.document_id).toBe(i.documentId);
  await ingestion.complete(job!,{chunks:[{id:'x',documentId:i.documentId,documentTitle:'Fixture',fileName:'fixture.pdf',sourcePath:'',format:'pdf',blockId:'page-1',text:'Volunteers must cancel at least 12 hours in advance.',page:1}],embeddings:[Array(1024).fill(0.1)],provider:'ollama',model:'qwen3-embedding:0.6b',ocrUsed:false,pageCount:1});return i;}
async function key(scopes=['chat:write']){await plan('api_access=true');return (await auth('post',`${base()}/api-keys`).send({name:'CRM',scopes,expiresAt:null}).expect(201)).body;}
const apiChat=(secret:string,organizationId=org)=>request(app).post(`/api/v1/organizations/${organizationId}/chatbots/${bot}/chat`).set('Authorization',`Bearer ${secret}`);
beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options={advisoryLockMode:'wait' as const,databaseUrl:process.env.DATABASE_URL!,dir:fileURLToPath(new URL('../../migrations',import.meta.url)),direction:'up' as const,migrationsTable:'pgmigrations',migrationsSchema:schema,schema:[schema,'public'],logger:{info(){},warn(){},error(){},debug(){}}};
  await runner({...options,count:5});legacy=await tenant();await runner(options);
  expect((await pool.query('SELECT plan_code FROM organization_subscriptions WHERE organization_id=$1',[legacy])).rows[0].plan_code).toBe('beta');
},30000);
afterAll(async()=>{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{
  await pool.query('DELETE FROM organizations');await pool.query('DELETE FROM object_cleanup_jobs');await pool.query('DELETE FROM rate_limit_windows');objects.clear();failDelete=false;failPut=false;failModel=false;
  await plan('chatbot_limit=1,monthly_message_limit=1000,document_limit=25,storage_bytes_limit=250000000,team_member_limit=2,api_access=false');
  org=await tenant();other=await tenant();bot=(await bots.create({organizationId:org,name:'Fixture'})).id;
  user=(await security.bootstrap('commercial-owner@example.test',password,org)).id;
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({email:'commercial-owner@example.test',password}).expect(200);
  cookie=login.headers['set-cookie'][0].split(';')[0];csrf=login.body.csrfToken;
  publicId=(await pool.query('UPDATE chatbots SET public_enabled=true WHERE id=$1 RETURNING public_id',[bot])).rows[0].public_id;
  await pool.query('INSERT INTO chatbot_allowed_origins(organization_id,chatbot_id,origin) VALUES($1,$2,$3)',[org,bot,origin]);
});
it('Gate 1: seeds plans/subscriptions, constraints and indexes without deleting prior organizations',async()=>{
  expect((await pool.query('SELECT count(*) FROM pgmigrations')).rows[0].count).toBe('8');
  expect((await pool.query('SELECT code FROM plans ORDER BY code')).rows.map(r=>r.code)).toEqual(['beta','business','growth','starter']);
  expect((await pool.query('SELECT count(*) FROM organization_subscriptions')).rows[0].count).toBe('2');
  await expect(plan('document_limit=-1')).rejects.toMatchObject({code:'23514'});
  await expect(pool.query("UPDATE organization_subscriptions SET status='unrecognized' WHERE organization_id=$1",[org])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query("INSERT INTO usage_counters VALUES($1,'arbitrary',now(),now()+interval '1 day',1,now())",[org])).rejects.toMatchObject({code:'23514'});
  expect((await pool.query('SELECT indexname FROM pg_indexes WHERE schemaname=$1',[schema])).rows.some(r=>r.indexname==='api_keys_org')).toBe(true);
});
it('Gate 2: concurrent public/internal consumption shares one exact allowance and audits refusals',async()=>{
  await plan('monthly_message_limit=5');
  const results=await Promise.allSettled(Array.from({length:25},(_,i)=>commercial.consumeMessage(org,i%2?'public_chat_messages':'internal_chat_messages')));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(5);
  const snapshot=await commercial.snapshot(org);expect(snapshot.usage.messages).toMatchObject({used:5,remaining:0});
  expect((await pool.query("SELECT count(*) FROM audit_events WHERE organization_id=$1 AND action='quota.exceeded'",[org])).rows[0].count).toBe('20');
});
it('Gate 2: chatbot quota is atomic and preserves existing bots',async()=>{
  await plan('chatbot_limit=2');
  const results=await Promise.allSettled(Array.from({length:5},()=>bots.create({organizationId:org,name:'Next'})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const r=await auth('post',`${base()}/chatbots`).send({name:'Over'}).expect(429);expect(r.body.error.code).toBe('QUOTA_EXCEEDED');
  expect((await bots.listByOrganization(org))).toHaveLength(2);
});
it('Gate 2: document/storage quota prevents racing uploads before storage PUT',async()=>{
  await plan('document_limit=2,storage_bytes_limit=20');
  const results=await Promise.allSettled(Array.from({length:6},()=>upload(10)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);expect(objects.size).toBe(2);
  expect((await commercial.snapshot(org)).usage.storageBytes.used).toBe(20);
  await plan('document_limit=10');await expect(upload(1)).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});
});
it('Gate 2: browser upload reports stable quota error',async()=>{
  await plan('document_limit=0');const pdf=await PDFDocument.create();pdf.addPage();const bytes=Buffer.from(await pdf.save());
  const r=await auth('post',`${base()}/chatbots/${bot}/documents`).attach('file',bytes,'valid.pdf').expect(429);expect(r.body.error.code).toBe('QUOTA_EXCEEDED');expect(objects.size).toBe(0);
});
it('Gate 2: owner bootstrap enforces member capacity without partially creating users',async()=>{
  await security.bootstrap('second@example.test',password,org);
  await expect(security.bootstrap('third@example.test',password,org)).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});
  expect((await pool.query("SELECT id FROM users WHERE email='third@example.test'")).rowCount).toBe(0);
  await security.bootstrap('second@example.test',password,org);expect((await commercial.snapshot(org)).usage.members.used).toBe(2);
});
it.each(['suspended','cancelled','past_due','trialing'])('Gate 2: blocks %s without valid trial/grace',async status=>{
  await pool.query('UPDATE organization_subscriptions SET status=$2 WHERE organization_id=$1',[org,status]);
  await expect(commercial.consumeMessage(org,'public_chat_messages')).rejects.toMatchObject({code:'SUBSCRIPTION_INACTIVE'});
  expect((await auth('get',`${base()}/entitlements`).expect(200)).body.allowed).toBe(false);
});
it('Gate 2: past due grace works until its exact expiry',async()=>{
  await pool.query("UPDATE organization_subscriptions SET status='past_due',grace_ends_at=now()+interval '1 hour' WHERE organization_id=$1",[org]);
  await commercial.consumeMessage(org,'public_chat_messages');
  await pool.query('UPDATE organization_subscriptions SET grace_ends_at=now() WHERE organization_id=$1',[org]);
  await expect(commercial.consumeMessage(org,'public_chat_messages')).rejects.toMatchObject({status:403});
});
it('Gate 3: commercial endpoints require current membership and browser mutations require CSRF',async()=>{
  for(const suffix of ['subscription','usage','entitlements','onboarding-status','api-keys','privacy/export']){
    await request(app).get(`${base()}/${suffix}`).expect(401);
    await auth('get',`/api/organizations/${other}/${suffix}`).expect(404);
  }
  await request(app).post(`${base()}/api-keys`).set('Cookie',cookie).send({name:'bad',scopes:['chat:write']}).expect(403);
  await auth('get','/api/plans').expect(200);await auth('get',`${base()}/usage?unexpected=1`).expect(200);
});
it('Gate 3: public validation consumes no quota; accepted chat and internal chat share quota',async()=>{
  await plan('monthly_message_limit=2');
  const path=`/api/public/chatbots/${publicId}/chat`;
  await request(app).post(path).send({message:'hi'}).expect(403);
  await request(app).post(path).set('Origin',origin).send({message:''}).expect(400);
  await request(app).post('/api/public/chatbots/pub_fake/chat').set('Origin',origin).send({message:'hi'}).expect(404);
  await request(app).post(`${base()}/chatbots/${bot}/chat`).send({message:'hi'}).expect(401);
  await auth('post',`${base()}/chatbots/${randomUUID()}/chat`).send({message:'hello'}).expect(404);
  await auth('post',`${base()}/chatbots/${bot}/chat`).send({message:''}).expect(400);
  await request(app).post(`${base()}/chatbots/${bot}/chat`).set('Cookie',cookie).send({message:'hello'}).expect(403);
  expect((await commercial.snapshot(org)).usage.messages.used).toBe(0);
  await request(app).post(path).set('Origin',origin).send({message:'hello'}).expect(200);
  await auth('post',`${base()}/chatbots/${bot}/chat`).send({message:'hello'}).expect(200);
  const r=await request(app).post(path).set('Origin',origin).send({message:'hello'}).expect(429);expect(r.body.error.code).toBe('QUOTA_EXCEEDED');
});
it('Gate 3: failed generation counts exactly once',async()=>{
  await ready();failModel=true;
  await request(app).post(`/api/public/chatbots/${publicId}/chat`).set('Origin',origin).send({message:'When must volunteers cancel?'}).expect(503);
  expect((await commercial.snapshot(org)).usage.messages.used).toBe(1);
});
it('Gate 3: period rollover retains history and resets current messages, not inventory',async()=>{
  await upload();await commercial.consumeMessage(org,'public_chat_messages');
  await pool.query("UPDATE organization_subscriptions SET current_period_start=now()-interval '60 days',current_period_end=now()-interval '30 days' WHERE organization_id=$1",[org]);
  const snapshot=await commercial.snapshot(org);expect(snapshot.usage.messages.used).toBe(0);expect(snapshot.usage.documents.used).toBe(1);
  expect((await pool.query('SELECT count(*) FROM usage_counters WHERE organization_id=$1',[org])).rows[0].count).toBe('3');
});
it('Gate 4: plan entitlement is required for API creation/use; only hashes persist',async()=>{
  await auth('post',`${base()}/api-keys`).send({name:'CRM',scopes:['chat:write']}).expect(403);
  const k=await key();const row=(await pool.query('SELECT * FROM api_keys WHERE id=$1',[k.apiKey.id])).rows[0];expect(row.secret_hash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(row)).not.toContain(k.secret);
  const listed=await auth('get',`${base()}/api-keys`).expect(200);expect(listed.text).not.toContain(k.secret);expect(listed.text).not.toContain(row.secret_hash);
  await apiChat(k.secret).send({message:'hello'}).expect(200);
  expect((await commercial.snapshot(org)).usage.apiRequests.used).toBe(1);
  expect((await pool.query('SELECT last_used_at FROM api_keys WHERE id=$1',[k.apiKey.id])).rows[0].last_used_at).not.toBeNull();
  await plan('api_access=false');await apiChat(k.secret).send({message:'hello'}).expect(403);
});
it('Gate 4: bearer scopes, organization isolation, expiry and revocation are enforced',async()=>{
  const k=await key();await apiChat(k.secret,other).send({message:'hello'}).expect(404);
  const reserved=await key(['documents:read']);await apiChat(reserved.secret).send({message:'hello'}).expect(403);
  await auth('delete',`${base()}/api-keys/${k.apiKey.id}`).expect(204);await apiChat(k.secret).send({message:'hi'}).expect(401);
  expect((await pool.query("SELECT id FROM audit_events WHERE organization_id=$1 AND action='api_key.revoked'",[org])).rowCount).toBe(1);
  const exp=await key();await pool.query("UPDATE api_keys SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[exp.apiKey.id]);await apiChat(exp.secret).send({message:'hi'}).expect(401);
  await apiChat('no_live_invalid').send({message:'hi'}).expect(401);
  await request(app).post(`/api/v1/organizations/${org}/chatbots/${bot}/chat`).set('Cookie',cookie).send({message:'hi'}).expect(401);
  expect((await commercial.snapshot(org)).usage.messages.used).toBe(0);
});
it('Gate 4: key management role checks, bounded pagination and strict schemas',async()=>{
  await key();await auth('get',`${base()}/api-keys?limit=101`).expect(400);
  await auth('post',`${base()}/api-keys`).send({name:'CRM',scopes:['root']}).expect(400);
  await pool.query("UPDATE organization_memberships SET role='member' WHERE organization_id=$1 AND user_id=$2",[org,user]);
  await auth('get',`${base()}/api-keys`).expect(403);await auth('post',`${base()}/api-keys`).send({name:'CRM',scopes:['chat:write']}).expect(403);
});
it('Gate 4: bearer requests remain independently rate limited',async()=>{
  const k=await key();for(let i=0;i<60;i++)await security.consume('api-key',[k.apiKey.id],60,60);
  const r=await apiChat(k.secret).send({message:'hi'}).expect(429);expect(r.body.error.code).toBe('RATE_LIMITED');expect(r.headers['retry-after']).toBeDefined();
  expect((await commercial.snapshot(org)).usage.messages.used).toBe(0);
});
it('Gate 5: onboarding requires ready eligible knowledge and exposes no document contents',async()=>{
  expect((await auth('get',`${base()}/onboarding-status`).expect(200)).body.installationReady).toBe(false);
  await ready();const r=await auth('get',`${base()}/onboarding-status`).expect(200);expect(r.body.installationReady).toBe(true);expect((await commercial.snapshot(org)).usage.ingestionPages.used).toBe(1);
});
it('Gate 5: deletion removes chunks/vectors/jobs, keeps durable storage cleanup and retries idempotently',async()=>{
  const i=await ready();const path=`${base()}/chatbots/${bot}/documents/${i.documentId}`;
  failDelete=true;await auth('delete',path).expect(202);
  for(const table of ['documents','document_chunks','document_embeddings','document_ingestion_jobs'])expect((await pool.query(`SELECT 1 FROM ${table} WHERE organization_id=$1`,[org])).rowCount).toBe(0);
  expect(await documents.cleanupOne(storage)).toBe(false);expect(objects.size).toBe(1);expect((await commercial.snapshot(org)).usage.storageBytes.used).toBe(10);
  await auth('delete',path).expect(202);
  expect((await pool.query("SELECT id FROM audit_events WHERE organization_id=$1 AND action='document.deleted'",[org])).rowCount).toBe(1);
  failDelete=false;await pool.query('UPDATE object_cleanup_jobs SET available_at=now()');expect(await documents.cleanupOne(storage)).toBe(true);expect(objects.size).toBe(0);
  expect((await commercial.snapshot(org)).usage.storageBytes.used).toBe(0);
});
it('Gate 5: ambiguous uploads leave durable cleanup; wrong tenant cannot delete resources',async()=>{
  failPut=true;await expect(upload()).rejects.toThrow();expect(objects.size).toBe(1);expect((await pool.query('SELECT * FROM object_cleanup_jobs')).rowCount).toBe(1);
  await pool.query('UPDATE object_cleanup_jobs SET available_at=now()');await documents.cleanupOne(storage);expect(objects.size).toBe(0);
  failPut=false;const i=await ready();await documents.delete({...i,organizationId:other},audit());expect(await ingestion.get(i)).not.toBeNull();
});
it('Gate 5: owner export excludes every stored secret and raw content, with pagination and audit',async()=>{
  const k=await key();await ready();
  const r=await auth('get',`${base()}/privacy/export?limit=1`).expect(200);
  for(const forbidden of ['password_hash','secret_hash','csrf_hash','token_hash','storage_key',password,csrf,k.secret,'Volunteers must cancel'])expect(r.text).not.toContain(forbidden);
  expect(r.body.sections.apiKeys.items).toHaveLength(1);expect(r.body.sections.auditEvents.hasMore).toBe(true);
  const rows=(await pool.query('SELECT action FROM audit_events WHERE organization_id=$1',[org])).rows.map(r=>r.action);expect(rows).toContain('privacy.exported');expect(rows).toContain('api_key.created');
  await pool.query("UPDATE organization_memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2",[org,user]);await auth('get',`${base()}/privacy/export`).expect(403);
});

it('Gate 5: export cutoff excludes its own read audits across pages',async()=>{
  const first=await auth('get',`${base()}/privacy/export?limit=1`).expect(200);
  expect(first.body.asOf).toBeDefined();
  const next=await auth('get',`${base()}/privacy/export?limit=100&asOf=${encodeURIComponent(first.body.asOf)}`).expect(200);
  expect(next.body.sections.auditEvents.items.some((r:any)=>r.action==='privacy.exported')).toBe(false);
  expect(next.body.sections.auditEvents.hasMore).toBe(false);
});
