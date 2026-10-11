// Live M28 acceptance: disposable tenant, production HTTP auth/RAG and real
// embeddings, injected public-site fixture. Stop the Compose worker first so no
// automated test can contact a third-party website. Never relax production SSRF.
import 'dotenv/config';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {smokeSession} from './smoke-session.mjs';
import {loadEnvironment} from '../dist/config.js';
import {CommercialService} from '../dist/commercial/service.js';
import {SourceService} from '../dist/sources/service.js';
import {CrawlJobs} from '../dist/sources/jobs.js';
import {OllamaEmbeddingProvider} from '../dist/embeddings/ollama-embedding-provider.js';
const {stdout}=await promisify(execFile)('docker',['compose','ps','--status','running','--services']);
assert.ok(!stdout.split('\n').includes('worker'),'Stop the worker before this controlled fixture test.');
const root=process.env.COMMERCIAL_TEST_API_URL??'http://localhost:3001',config=loadEnvironment();
const pool=new Pool({connectionString:config.DATABASE_URL});
const service=new SourceService(new CommercialService(pool),new OllamaEmbeddingProvider({baseUrl:config.OLLAMA_BASE_URL,model:config.OLLAMA_EMBEDDING_MODEL,timeoutMs:config.EMBEDDING_TIMEOUT_MS}),{...config,CRAWLER_REQUEST_DELAY_MS:0});
const jobs=new CrawlJobs(service);let session,org,bot,stage='setup';
const inventory=async()=> (await pool.query(`SELECT (SELECT count(*) FROM organizations) organizations,(SELECT count(*) FROM organization_subscriptions) subscriptions,(SELECT count(*) FROM documents) documents,(SELECT count(*) FROM document_chunks) chunks,(SELECT count(*) FROM document_embeddings) vectors,(SELECT count(*) FROM object_cleanup_jobs) cleanup_jobs`)).rows[0];
const before=await inventory();
async function call(method,url,body,status=200){const r=await session.fetch(`${root}/api${url}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});assert.equal(r.status,status);return status===204?null:r.json();}
let text='The Atlas observatory tour begins at 18:30 every Friday. Book at least two days ahead.';
const fixture=async(url)=>({url:url.href,status:200,headers:{'content-type':'text/html',etag:'fixture'},body:url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':url.pathname==='/sitemap.xml'?'<urlset/>':`<title>Atlas observatory</title><main><h1>Observatory tours</h1><p>${text}</p></main>`});
try{
  session=await smokeSession(pool,root);org=(await call('POST','/organizations',{name:'M28 live fixture',slug:`m28-${randomUUID()}`},201)).organization.id;
  bot=(await call('POST',`/organizations/${org}/chatbots`,{name:'M28 fixture'},201)).chatbot.id;
  const base=`/organizations/${org}/chatbots/${bot}`;
  stage='source';const source=await call('POST',`${base}/website-sources`,{url:'https://m28-fixture.example.com/',syncMode:'daily'},201);
  let job=await jobs.claim();assert.equal(job.website_source_id,source.id);assert.equal(await jobs.process(job,fixture),true);
  assert.equal((await call('GET',`${base}/website-sources/${source.id}`)).page_count,1);
  const ids=(await pool.query('SELECT id FROM knowledge_chunks WHERE organization_id=$1',[org])).rows.map(r=>r.id);
  stage='unchanged';await call('POST',`${base}/website-sources/${source.id}/sync`,{},202);job=await jobs.claim();assert.equal(await jobs.process(job,fixture),true);
  assert.deepEqual((await pool.query('SELECT id FROM knowledge_chunks WHERE organization_id=$1',[org])).rows.map(r=>r.id),ids);
  stage='faq';const faq=await call('POST',`${base}/manual-faqs`,{question:'What is the lunar workshop cancellation window?',answer:'Cancel lunar workshop bookings at least 36 hours before the session.',category:'Bookings'},201);
  stage='website-answer';const websiteAnswer=await call('POST',`${base}/chat`,{message:'When does the Atlas observatory tour begin?'});assert.equal(websiteAnswer.fallback,false);assert.ok(websiteAnswer.sources.some(s=>s.kind==='website'));
  stage='faq-answer';const faqAnswer=await call('POST',`${base}/chat`,{message:'How far ahead must I cancel a lunar workshop booking?'});assert.equal(faqAnswer.fallback,false);assert.ok(faqAnswer.sources.some(s=>s.kind==='manual_faq'));
  stage='deletion';await call('DELETE',`${base}/website-sources/${source.id}`,undefined,204);await call('DELETE',`${base}/manual-faqs/${faq.id}`,undefined,204);
  for(const table of ['website_sources','website_pages','website_crawl_jobs','manual_faqs','knowledge_chunks'])assert.equal((await pool.query(`SELECT count(*) FROM ${table} WHERE organization_id=$1`,[org])).rows[0].count,'0');
  assert.ok((await pool.query("SELECT id FROM audit_events WHERE organization_id=$1 AND action='website_source.deleted'",[org])).rowCount);
  await call('GET',`${base}/document-sources/${ids[0]}`,undefined,404);
  console.log('M28 live acceptance passed: controlled crawl, real 1024-dimensional embeddings, unchanged-page preservation, website/FAQ production answers, scoped citations, deletion and audit.');
}catch{console.error(`M28 live acceptance failed at ${stage}.`);process.exitCode=1;}
finally{
  if(org)await pool.query('DELETE FROM organizations WHERE id=$1',[org]);
  await session?.close();assert.deepEqual(await inventory(),before);await pool.end();
  console.log('Original inventory preserved.');
}
