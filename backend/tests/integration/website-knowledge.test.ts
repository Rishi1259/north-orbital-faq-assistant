import 'dotenv/config';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {runner} from 'node-pg-migrate';
import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
import request from 'supertest';
import {SourceService} from '../../src/sources/service.js';
import {CrawlJobs} from '../../src/sources/jobs.js';
import {CrawlError,CrawlerEnvironmentSchema} from '../../src/sources/config.js';
import type {Transport} from '../../src/sources/http.js';
import {CommercialService} from '../../src/commercial/service.js';
import {PostgresRetrievalRepository} from '../../src/rag/repository.js';
import {createApp} from '../../src/app.js';
import {SecurityRepository} from '../../src/security/repository.js';
import {loadSecurityConfig} from '../../src/security/config.js';
import {randomToken} from '../../src/security/crypto.js';
import {PublicChatbotRepository} from '../../src/public/repository.js';
import {PrivacyService} from '../../src/commercial/privacy.js';
import {createProductionChatService} from '../../src/rag/chat-service.js';
import {ProductionRetriever} from '../../src/rag/retriever.js';
import {config as ragConfig,identity,vector} from '../rag-fixtures.js';
import pino from 'pino';
const schema=`m28_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:process.env.DATABASE_URL});
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema},public`,max:12});
const config=CrawlerEnvironmentSchema.parse({CRAWLER_REQUEST_DELAY_MS:0}),commercial=new CommercialService(pool);
const embedding=vi.fn(async(texts:string[])=>texts.map(()=>vector()));
const sources=new SourceService(commercial,{embed:embedding},config),jobs=new CrawlJobs(sources),repository=new PostgresRetrievalRepository(pool);
const securityConfig=loadSecurityConfig({NODE_ENV:'test',RATE_LIMIT_HASH_SECRET:randomToken(),SESSION_COOKIE_SECURE:'false',LOCAL_HTTP_DEVELOPMENT:'true'}),security=new SecurityRepository(pool,securityConfig);
const app=createApp({sourceService:sources,security,securityConfig,commercial,retrievalRepository:repository,publicChatbots:new PublicChatbotRepository(pool,security)});
let scope:{organizationId:string;chatbotId:string},other:typeof scope,user:string,cookie:string,csrf:string;
let page='Orion workshops start at nine on Saturdays.',map=['/a'],etag='v1',notModified=false,broken=false;
const transport:Transport=async(url,headers)=>{
  if(url.pathname==='/robots.txt')return {url:url.href,status:200,headers:{},body:'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml'};
  if(url.pathname==='/sitemap.xml')return {url:url.href,status:200,headers:{},body:`<urlset>${map.map(p=>`<url><loc>https://example.com${p}</loc></url>`).join('')}</urlset>`};
  if(broken)throw new CrawlError('TIMEOUT',true);
  return {url:url.href,status:notModified && headers['if-none-match']===etag?304:200,headers:{'content-type':'text/html',etag},body:`<title>Orion workshops</title><nav>Navigation noise</nav><main><h1>Orion</h1><p>${page}</p></main>`};
};
const audit=()=>({actorUserId:user,action:'test',targetType:'source'});
const base=()=>`/api/organizations/${scope.organizationId}/chatbots/${scope.chatbotId}`;
const auth=(method:'get'|'post'|'put'|'patch'|'delete',path:string)=>request(app)[method](base()+path).set('Cookie',cookie).set('X-CSRF-Token',csrf);
async function tenant(){const organizationId=(await pool.query("INSERT INTO organizations(name,slug) VALUES('M28',$1) RETURNING id",[randomUUID()])).rows[0].id;const chatbotId=(await pool.query("INSERT INTO chatbots(organization_id,name) VALUES($1,'M28') RETURNING id",[organizationId])).rows[0].id;return {organizationId,chatbotId};}
async function create(){return sources.create(scope,{url:'https://example.com/',syncMode:'manual'},audit());}
async function run(){const job=await jobs.claim();expect(job).toBeDefined();expect(await jobs.process(job!,transport)).toBe(true);return job!;}
beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runner({advisoryLockMode:'wait',databaseUrl:process.env.DATABASE_URL!,dir:fileURLToPath(new URL('../../migrations',import.meta.url)),direction:'up',migrationsTable:'pgmigrations',migrationsSchema:schema,schema:[schema,'public'],logger:{info(){},warn(){},error(){},debug(){}}});
},30000);
afterAll(async()=>{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{
  await pool.query('DELETE FROM organizations');await pool.query('DELETE FROM rate_limit_windows');
  await pool.query('UPDATE plans SET knowledge_page_limit=200,indexed_bytes_limit=20000000,website_source_limit=5');
  scope=await tenant();other=await tenant();user=(await security.bootstrap('m28@example.com','M28 test strong password',scope.organizationId)).id;
  const login=await request(app).post('/api/auth/login').set('Origin','http://localhost:4200').send({email:'m28@example.com',password:'M28 test strong password'}).expect(200);
  cookie=login.headers['set-cookie'][0].split(';')[0];csrf=login.body.csrfToken;
  page='Orion workshops start at nine on Saturdays.';map=['/a'];etag='v1';notModified=false;broken=false;embedding.mockClear();
});
it('Gate 1: seventh migration, scoped constraints, normalized URL uniqueness',async()=>{
  expect((await pool.query('SELECT count(*) FROM pgmigrations')).rows[0].count).toBe('7');const s=await create();
  await expect(create()).rejects.toMatchObject({code:'23505'});
  await expect(pool.query("INSERT INTO website_pages(organization_id,chatbot_id,website_source_id,canonical_url,path,title,state) VALUES($1,$2,$3,'https://example.com/x','/x','x','active')",[other.organizationId,other.chatbotId,s.id])).rejects.toMatchObject({code:'23503'});
});
it('Gate 3: real database indexing, extraction, FTS, 1024 vectors and provenance',async()=>{
  const s=await create();await run();const rows=await repository.lexical(scope,'Orion workshops',30);expect(rows.length).toBeGreaterThan(0);expect(rows[0]).toMatchObject({sourceType:'website',sourceId:s.id,title:'Orion workshops'});expect(rows[0]!.text).not.toContain('Navigation noise');
  expect((await pool.query('SELECT DISTINCT vector_dims(embedding) n FROM knowledge_chunks')).rows).toEqual([{n:1024}]);
  expect((await repository.semantic(scope,vector(),identity,30))[0]!.sourceType).toBe('website');expect(await repository.lexical(other,'Orion',30)).toEqual([]);
});
it('Gate 4: unchanged and 304 preserve stable chunks and never re-embed',async()=>{
  const s=await create();await run();const ids=(await repository.lexical(scope,'Orion',30)).map(c=>c.id);embedding.mockClear();
  await sources.sync(scope,s.id,audit());await run();expect(embedding).not.toHaveBeenCalled();expect((await repository.lexical(scope,'Orion',30)).map(c=>c.id)).toEqual(ids);
  notModified=true;await sources.sync(scope,s.id,audit());await run();expect(embedding).not.toHaveBeenCalled();expect((await repository.getByIds(scope,ids))).toHaveLength(ids.length);
});
it('Gate 4: changed pages replace old chunks and deleted evidence cannot be cited',async()=>{
  const s=await create();await run();const ids=(await repository.lexical(scope,'Orion',30)).map(c=>c.id);embedding.mockClear();page='Andromeda classes now start at noon.';etag='v2';
  await sources.sync(scope,s.id,audit());await run();expect(embedding).toHaveBeenCalled();expect(await repository.getByIds(scope,ids)).toEqual([]);expect((await repository.lexical(scope,'Andromeda',30)).length).toBeGreaterThan(0);
});
it('Gate 4: complete discovery removes missing pages; partial failure preserves prior index',async()=>{
  const s=await create();await run();broken=true;await sources.sync(scope,s.id,audit());const job=await jobs.claim();expect(await jobs.process(job!,transport)).toBe(false);expect((await sources.get(scope,s.id)).page_count).toBe(2);
  broken=false;map=[];await pool.query("UPDATE website_crawl_jobs SET available_at=now() WHERE state='queued'");await run();expect((await sources.get(scope,s.id)).page_count).toBe(1);expect((await pool.query("SELECT state FROM website_pages WHERE path='/a'")).rows[0].state).toBe('removed');
});
it('Gate 4: concurrent sync deduplicates and SKIP LOCKED workers claim once',async()=>{
  const s=await create();await Promise.all(Array.from({length:10},()=>sources.sync(scope,s.id,audit())));expect((await pool.query("SELECT count(*) FROM website_crawl_jobs WHERE state='queued'")).rows[0].count).toBe('1');
  const claims=await Promise.all(Array.from({length:5},()=>jobs.claim()));expect(claims.filter(Boolean)).toHaveLength(1);
});
it('Gate 4: stale recovery fences old workers and max attempts becomes terminal',async()=>{
  const source=await create();const old=(await jobs.claim())!;
  await pool.query("UPDATE website_sources SET status='syncing',sync_mode='weekly' WHERE id=$1",[source.id]);
  await pool.query("UPDATE website_crawl_jobs SET lease_at=now()-interval '2 minutes'");expect(await jobs.recover()).toBe(1);expect(await jobs.finish(old,{pages:[],complete:true})).toBe(false);
  expect((await sources.get(scope,source.id)).next_sync_at.getTime()-Date.now()).toBeGreaterThan(6*86400000);
  await pool.query("UPDATE website_crawl_jobs SET available_at=now(),attempts=max_attempts-1");const final=(await jobs.claim())!;await jobs.fail(final,new CrawlError('TIMEOUT',true));expect((await pool.query('SELECT state FROM website_crawl_jobs')).rows[0].state).toBe('failed');
});
it('Gate 4: permanent failures do not retry and automatic schedule queues due sources',async()=>{
  const s=await create();const job=(await jobs.claim())!;await jobs.fail(job,new CrawlError('ROBOTS_DISALLOWED'));expect(await jobs.claim()).toBeUndefined();
  await sources.update(scope,s.id,{syncMode:'daily'},audit());await pool.query("UPDATE website_sources SET next_sync_at=now()-interval '1 minute'");await jobs.schedule();await run();expect((await sources.get(scope,s.id)).next_sync_at.getTime()).toBeGreaterThan(Date.now());
});
it('Gate 5: FAQ create/update/delete is atomically indexed and audited',async()=>{
  const f=await sources.saveFaq(scope,{question:'What is Vega?',answer:'Vega is our music program.',category:'Programs'},audit());expect((await repository.lexical(scope,'Vega',10))[0]!.sourceType).toBe('manual_faq');const old=(await repository.lexical(scope,'Vega',10))[0]!.id;
  await sources.saveFaq(scope,{question:'What is Vega?',answer:'Vega is our science program.',category:'Programs'},audit(),f.id);expect(await repository.getByIds(scope,[old])).toEqual([]);expect((await repository.lexical(scope,'science',10))).toHaveLength(1);
  await sources.remove(scope,f.id,true,audit());expect(await repository.lexical(scope,'Vega',10)).toEqual([]);expect((await pool.query("SELECT action FROM audit_events WHERE target_id=$1 ORDER BY created_at",[f.id])).rows.map(r=>r.action)).toEqual(['manual_faq.created','manual_faq.updated','manual_faq.deleted']);
});
it('Gate 5: owner/admin HTTP, member denial, CSRF, validation and tenant isolation',async()=>{
  await auth('post','/manual-faqs').send({question:'Q',answer:'A'}).expect(201);
  await pool.query("UPDATE organization_memberships SET role='admin' WHERE organization_id=$1",[scope.organizationId]);await auth('post','/manual-faqs').send({question:'Q2',answer:'A2'}).expect(201);
  await auth('post','/manual-faqs').send({question:'',answer:'A'}).expect(400);await auth('post','/website-sources').send({url:'http://127.0.0.1'}).expect(400);
  await request(app).post(base()+'/manual-faqs').set('Cookie',cookie).send({question:'Q',answer:'A'}).expect(403);
  const f=await sources.saveFaq(other,{question:'secret',answer:'secret',category:''},audit());await auth('get','/manual-faqs/'+f.id).expect(404);
  await pool.query("UPDATE organization_memberships SET role='member' WHERE organization_id=$1",[scope.organizationId]);await auth('post','/website-sources').send({url:'https://example.com'}).expect(403);await auth('post','/manual-faqs').send({question:'Q',answer:'A'}).expect(403);await auth('get','/manual-faqs').expect(200);
});
it('Gate 5: privacy exports safe sources and FAQ content without embeddings/jobs',async()=>{
  await create();await run();await sources.saveFaq(scope,{question:'Vega?',answer:'Music',category:''},audit());const result=await new PrivacyService(commercial).export(scope.organizationId,100,0,audit());
  expect(result.sections.websiteSources.items).toHaveLength(1);expect(result.sections.websitePages.items).toHaveLength(2);expect(result.sections.manualFaqs.items).toHaveLength(1);expect(JSON.stringify(result)).not.toMatch(/embedding|worker_id|lease_at/);
});
it('Gate 6: mixed production RRF and validated citations; fake IDs and unrelated queries fallback',async()=>{
  await create();await run();await sources.saveFaq(scope,{question:'Vega music?',answer:'Vega lessons start at ten.',category:''},audit());
  const doc=(await pool.query("INSERT INTO documents(organization_id,chatbot_id,title,original_filename,mime_type,status,storage_key) VALUES($1,$2,'PDF','a.pdf','application/pdf','ready','fixture') RETURNING id",[scope.organizationId,scope.chatbotId])).rows[0].id;
  const chunk=(await pool.query("INSERT INTO document_chunks(organization_id,chatbot_id,document_id,chunk_index,content,page_number) VALUES($1,$2,$3,0,'Sirius library opens at eight.',1) RETURNING id",[scope.organizationId,scope.chatbotId,doc])).rows[0].id;
  await pool.query("INSERT INTO document_embeddings(organization_id,chatbot_id,document_id,chunk_id,provider,model,dimensions,embedding) VALUES($1,$2,$3,$4,'ollama','qwen3-embedding:0.6b',1024,$5::vector)",[scope.organizationId,scope.chatbotId,doc,chunk,JSON.stringify(vector(1))]);
  const retriever=new ProductionRetriever({repository,embeddings:{embed:async()=>{throw new Error('use lexical for deterministic distinct questions');}},identity,config:{...ragConfig,RAG_QUERY_REWRITE_ENABLED:false},logger:pino({level:'silent'})});
  let fake=false;const chat=createProductionChatService({generateAnswer:async()=>({canAnswer:true,answer:'Supported answer.',sourceIds:[fake?'S99':'S1']})},retriever,repository);
  for(const [message,kind] of [['Sirius library','document'],['Orion workshops','website'],['Vega music','manual_faq']])expect((await chat.chat(scope,{message,history:[]})).sources[0]!.kind).toBe(kind);
  expect(new Set((await retriever.retrieve(scope,'Orion Vega Sirius',[])).map(e=>e.chunk.sourceType)).size).toBe(3);
  fake=true;expect((await chat.chat(scope,{message:'Vega',history:[]})).fallback).toBe(true);expect((await chat.chat(scope,{message:'unrelatedquasar',history:[]})).fallback).toBe(true);
});
it('Gate 7: atomic quotas, deletion cascade, scoped citation lookup and no pending work',async()=>{
  await pool.query('UPDATE plans SET knowledge_page_limit=1');const results=await Promise.allSettled(Array.from({length:4},(_,i)=>sources.saveFaq(scope,{question:`Q${i}`,answer:'bounded',category:''},audit())));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  await pool.query('UPDATE plans SET knowledge_page_limit=200');const s=await create();await run();const ids=(await repository.lexical(scope,'Orion',10)).map(c=>c.id);await sources.sync(scope,s.id,audit());await sources.remove(scope,s.id,false,audit());expect(await repository.getByIds(scope,ids)).toEqual([]);
  for(const table of ['website_sources','website_pages','website_crawl_jobs'])expect((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count).toBe('0');expect((await pool.query('SELECT count(*) FROM knowledge_chunks WHERE website_source_id=$1',[s.id])).rows[0].count).toBe('0');
});

it('Gate 7: public website/FAQ citations expose bounded metadata and disappear after deletion',async()=>{
  const s=await create();await run();const f=await sources.saveFaq(scope,{question:'PublicFAQ',answer:'Safe public answer',category:''},audit());
  const publicId=(await pool.query('UPDATE chatbots SET public_enabled=true WHERE id=$1 RETURNING public_id',[scope.chatbotId])).rows[0].public_id;
  await pool.query("INSERT INTO chatbot_allowed_origins(organization_id,chatbot_id,origin) VALUES($1,$2,'https://customer.example')",[scope.organizationId,scope.chatbotId]);
  const website=(await repository.lexical(scope,'Orion',10))[0]!,faq=(await repository.lexical(scope,'PublicFAQ',10))[0]!;
  const get=(id:string)=>request(app).get(`/api/public/chatbots/${publicId}/document-sources/${id}`).set('Origin','https://customer.example');
  const r=await get(website.id).expect(200);expect(r.body.sourceType).toBe('website');expect(r.body.canonicalUrl).toMatch(/^https:\/\/example.com/);expect(r.text).not.toContain(scope.organizationId);expect(r.text).not.toMatch(/embedding|worker|created_by/);
  expect((await get(faq.id).expect(200)).body.sourceType).toBe('manual_faq');await get(randomUUID()).expect(404);
  await sources.remove(scope,s.id,false,audit());await sources.remove(scope,f.id,true,audit());await get(website.id).expect(404);await get(faq.id).expect(404);
});
it('Gate 7: source mutations are rate limited and website pages are paginated/scoped',async()=>{
  const s=await create();await run();const list=await auth('get',`/website-sources/${s.id}/pages?limit=1`).expect(200);expect(list.body.items).toHaveLength(1);expect(list.text).not.toMatch(/embedding|content_hash/);
  await auth('get',`/website-sources/${s.id}/pages?limit=101`).expect(400);
  for(let i=0;i<30;i++)await security.consume('knowledge-mutation',[scope.organizationId,user],30,3600);
  await auth('post',`/website-sources/${s.id}/sync`).send({}).expect(429);
});
it('Gate 7: quota failure rolls back changed content and preserves old evidence',async()=>{
  const s=await create();await run();const old=await repository.lexical(scope,'Orion',10);page='Changed entirely to Andromeda';
  await pool.query('UPDATE plans SET indexed_bytes_limit=1');await sources.sync(scope,s.id,audit());const job=(await jobs.claim())!;expect(await jobs.process(job,transport)).toBe(false);
  expect((await repository.getByIds(scope,old.map(p=>p.id))).map(p=>p.text)).toEqual(old.map(p=>p.text));expect((await sources.get(scope,s.id)).latest_error_code).toBe('QUOTA_EXCEEDED');
});
it('Gate 7: disabled source fences leased work, hides citations and cancels pending jobs',async()=>{
  const s=await create();await run();const ids=(await repository.lexical(scope,'Orion',10)).map(p=>p.id);await sources.sync(scope,s.id,audit());const job=(await jobs.claim())!;
  await sources.update(scope,s.id,{disabled:true},audit());expect(await jobs.finish(job,{pages:[],complete:true})).toBe(false);expect(await repository.getByIds(scope,ids)).toEqual([]);expect(await jobs.claim()).toBeUndefined();
});
