// M29 controlled live acceptance. All mutations belong to disposable fixtures.
// Outputs only stages, counts and statuses; never prints submitted PII or credentials.
import 'dotenv/config';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Pool} from 'pg';
import {smokeSession} from './smoke-session.mjs';
import {loadEnvironment} from '../dist/config.js';
const config=loadEnvironment(),pool=new Pool({connectionString:config.DATABASE_URL});
const root=process.env.COMMERCIAL_TEST_API_URL??'http://localhost:3001';
const tables=['organizations','organization_subscriptions','documents','document_chunks','document_embeddings','object_cleanup_jobs','website_sources','website_pages','website_crawl_jobs','manual_faqs','knowledge_chunks','lead_capture_settings','leads','handoff_requests'];
const inventory=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,Number((await pool.query(`SELECT count(*) n FROM ${t}`)).rows[0].n)])));
const before=await inventory();let session,org,bot,stage='setup';
const stamp=randomUUID().replaceAll('-',''),canaries={name:`M29Name${stamp}`,email:`m29-${stamp}@example.test`,phone:`+99 ${String(Date.now()).slice(-12)}`,company:`M29Company${stamp}`,visitorMessage:`M29Message${stamp}`};
async function call(method,path,body,status=200){const r=await session.fetch(`${root}/api${path}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});assert.equal(r.status,status);return status===204?null:r.json();}
try{
  session=await smokeSession(pool,root);
  org=(await call('POST','/organizations',{name:'M29 disposable acceptance',slug:`m29-${randomUUID()}`},201)).organization.id;
  bot=(await call('POST',`/organizations/${org}/chatbots`,{name:'M29 fixture'},201)).chatbot.id;
  const base=`/organizations/${org}/chatbots/${bot}`;
  const owner=(await pool.query('SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND role=$2',[org,'owner'])).rows[0].user_id;
  stage='configuration';
  await call('PUT',`${base}/allowed-origins`,{origins:[config.ADMIN_APP_ORIGIN]});await call('PUT',`${base}/public-access`,{enabled:true});
  const settings=await call('PUT',`${base}/lead-settings`,{enabled:true,handoffEnabled:true,collectPhone:true,collectCompany:true,requireName:true,consentRequired:true,consentText:'I agree to follow-up about this request.'});
  const publicId=(await call('GET',`${base}/public-settings`)).publicId;
  const publicBase=`${root}/api/public/chatbots/${publicId}`;
  const publicConfig=await fetch(publicBase+'/config',{headers:{Origin:config.ADMIN_APP_ORIGIN}});assert.equal(publicConfig.status,200);const publicText=await publicConfig.text();assert.ok(!publicText.includes(org));assert.ok(!publicText.includes(bot));assert.ok(!publicText.includes('consentVersion'));
  async function submit(handoff,key=randomUUID()){const r=await fetch(publicBase+(handoff?'/handoff':'/leads'),{method:'POST',headers:{Origin:config.ADMIN_APP_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({...canaries,idempotencyKey:key,source:'widget',consentGiven:true,...(handoff?{reason:canaries.visitorMessage}:{})})});assert.equal(r.status,202);assert.deepEqual(await r.json(),{status:'accepted'});}
  stage='public-create';const key=randomUUID();await submit(false,key);await submit(false,key);await submit(true);
  let leads=(await call('GET',base+'/leads')).items;let handoffs=(await call('GET',base+'/handoffs')).items;assert.equal(leads.length,2);assert.equal(handoffs.length,1);assert.equal(leads[0].consent_version,settings.consentVersion);
  assert.deepEqual((await pool.query('SELECT metric,quantity::int FROM usage_counters WHERE organization_id=$1 ORDER BY metric',[org])).rows,[{metric:'handoffs_requested',quantity:1},{metric:'leads_created',quantity:2}]);
  stage='workflow';let h=handoffs[0];for(const [action,extra] of [['acknowledge',{}],['assign',{assignedUserId:owner}],['resolve',{}]])h=await call('PATCH',`${base}/handoffs/${h.id}`,{action,revision:h.revision,...extra});assert.equal(h.status,'resolved');
  await call('PATCH',`${base}/leads/${h.lead_id}`,{status:'contacted'});
  stage='privacy-export';const exported=await call('GET',`/organizations/${org}/privacy/export`);assert.equal(exported.sections.leads.items.length,2);assert.equal(exported.sections.handoffs.items.length,1);assert.equal(exported.sections.leadSettings.items.length,1);
  for(const secret of ['password_hash','csrf_hash','token_hash','secret_hash','key_hash','authorization','127.0.0.1'])assert.ok(!JSON.stringify(exported).includes(secret));
  stage='audit-privacy';const events=(await pool.query("SELECT action,metadata FROM audit_events WHERE organization_id=$1 AND (action LIKE 'lead%' OR action LIKE 'handoff%')",[org])).rows;
  for(const value of Object.values(canaries))assert.ok(!JSON.stringify(events).includes(value));
  console.log('M29 audit events by action:',JSON.stringify(Object.fromEntries([...new Set(events.map(e=>e.action))].map(a=>[a,events.filter(e=>e.action===a).length]))));
  stage='log-privacy';await new Promise(r=>setTimeout(r,300));const {stdout}=await promisify(execFile)('docker',['compose','logs','--no-color','backend','worker'],{maxBuffer:64*1024*1024});
  for(const [field,value] of Object.entries(canaries)){const count=stdout.split(value).length-1;console.log(`M29 ${field} canary matches: ${count}`);assert.equal(count,0);}
  stage='deletion';for(const l of leads)await call('DELETE',`${base}/leads/${l.id}`,undefined,204);
  assert.equal((await call('GET',base+'/leads')).items.length,0);assert.equal((await call('GET',base+'/handoffs')).items.length,0);
  const clean=await call('GET',`/organizations/${org}/privacy/export`);assert.equal(clean.sections.leads.items.length,0);assert.equal(clean.sections.handoffs.items.length,0);
  stage='operations';for(const endpoint of ['health','ready']){const r=await fetch(`${root}/api/${endpoint}`);assert.equal(r.status,200);console.log(`${endpoint}: ${r.status}`);}
  console.log('M29 live acceptance: configuration, public config, lead, handoff, idempotency, staff workflow, export, audit/log privacy and deletion passed.');
}catch{console.error(`M29 live acceptance failed at ${stage}.`);process.exitCode=1;}
finally{
  if(org)await pool.query('DELETE FROM organizations WHERE id=$1',[org]);
  await session?.close();const after=await inventory();assert.deepEqual(after,before);console.log('M29 fixture cleanup: baseline counts preserved.');console.log(JSON.stringify(after));await pool.end();
}
