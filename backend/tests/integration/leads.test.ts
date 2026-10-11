import 'dotenv/config';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {runner} from 'node-pg-migrate';
import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
import request from 'supertest';
import {CommercialService} from '../../src/commercial/service.js';
import {createApp} from '../../src/app.js';
import {SecurityRepository} from '../../src/security/repository.js';
import {loadSecurityConfig} from '../../src/security/config.js';
import {randomToken} from '../../src/security/crypto.js';
import {PublicChatbotRepository} from '../../src/public/repository.js';
import {SettingsSchema} from '../../src/leads/model.js';
import {LeadService} from '../../src/leads/service.js';
const schema=`m29_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:process.env.DATABASE_URL});
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema},public`,max:12});
const config=loadSecurityConfig({NODE_ENV:'test',RATE_LIMIT_HASH_SECRET:randomToken(),SESSION_COOKIE_SECURE:'false',LOCAL_HTTP_DEVELOPMENT:'true'});
const security=new SecurityRepository(pool,config),commercial=new CommercialService(pool),service=new LeadService(commercial),bots=new PublicChatbotRepository(pool,security);
const app=createApp({security,securityConfig:config,commercial,publicChatbots:bots});
const origin='http://localhost:4200',password='M29 fictional test password';
let org:string,bot:string,otherOrg:string,otherBot:string,sibling:string,user:string,foreignUser:string,member:string,adminUser:string,publicId:string,cookie:string,csrf:string;
const base=()=>`/api/organizations/${org}/chatbots/${bot}`;
const auth=(method:'get'|'post'|'put'|'patch'|'delete',path:string)=>request(app)[method](base()+path).set('Cookie',cookie).set('X-CSRF-Token',csrf);
const data=(extra={})=>({idempotencyKey:randomUUID(),email:'lead@example.test',...extra});
const submit=(handoff=false,input=data())=>request(app).post(`/api/public/chatbots/${publicId}/${handoff?'handoff':'leads'}`).set('Origin',origin).send(input);
async function tenant(){const o=(await pool.query("INSERT INTO organizations(name,slug) VALUES('M29 fixture',$1) RETURNING id",[randomUUID()])).rows[0].id;const b=(await pool.query("INSERT INTO chatbots(organization_id,name,public_enabled) VALUES($1,'M29',true) RETURNING id,public_id",[o])).rows[0];await pool.query('INSERT INTO chatbot_allowed_origins(organization_id,chatbot_id,origin) VALUES($1,$2,$3)',[o,b.id,origin]);return {org:o,bot:b.id,publicId:b.public_id};}
async function settings(extra={}){return auth('put','/lead-settings').send(SettingsSchema.parse({enabled:true,handoffEnabled:true,...extra})).expect(200);}
async function counts(){return (await pool.query('SELECT (SELECT count(*)::int FROM leads) leads,(SELECT count(*)::int FROM handoff_requests) handoffs,(SELECT coalesce(sum(quantity),0)::int FROM usage_counters) usage')).rows[0];}
async function handoff(){await submit(true,data({reason:'Please help with a booking.'})).expect(202);return (await auth('get','/handoffs').expect(200)).body.items[0];}
beforeAll(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await runner({advisoryLockMode:'wait',databaseUrl:process.env.DATABASE_URL!,dir:fileURLToPath(new URL('../../migrations',import.meta.url)),direction:'up',migrationsTable:'pgmigrations',migrationsSchema:schema,schema:[schema,'public'],logger:{info(){},warn(){},error(){},debug(){}}});},30000);
afterAll(async()=>{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{
  await pool.query('DELETE FROM organizations');await pool.query('DELETE FROM rate_limit_windows');
  await pool.query('UPDATE plans SET lead_capture_enabled=true,human_handoff_enabled=true,monthly_lead_limit=100,monthly_handoff_limit=25,team_member_limit=10');
  ({org,bot,publicId}=await tenant());({org:otherOrg,bot:otherBot}=await tenant());
  sibling=(await pool.query("INSERT INTO chatbots(organization_id,name) VALUES($1,'Sibling') RETURNING id",[org])).rows[0].id;
  user=(await security.bootstrap('m29-owner@example.test',password,org)).id;
  foreignUser=(await security.bootstrap('m29-foreign@example.test',password,otherOrg)).id;
  member=(await security.bootstrap('m29-member@example.test',password,org)).id;
  adminUser=(await security.bootstrap('m29-admin@example.test',password,org)).id;
  await pool.query("UPDATE organization_memberships SET role='member' WHERE organization_id=$1 AND user_id=$2",[org,member]);
  await pool.query("UPDATE organization_memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2",[org,adminUser]);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({email:'m29-owner@example.test',password}).expect(200);cookie=login.headers['set-cookie'][0].split(';')[0];csrf=login.body.csrfToken;await settings();
});
it('schema has 8 migrations, status and tenant/assignment constraints',async()=>{
  expect((await pool.query('SELECT count(*) FROM pgmigrations')).rows[0].count).toBe('8');const h=await handoff();
  await expect(pool.query("UPDATE leads SET status='anything'")).rejects.toMatchObject({code:'23514'});
  await expect(pool.query("UPDATE handoff_requests SET status='anything'")).rejects.toMatchObject({code:'23514'});
  await expect(pool.query('UPDATE handoff_requests SET assigned_user_id=$1',[foreignUser])).rejects.toMatchObject({code:'23503'});
  await expect(pool.query('UPDATE handoff_requests SET chatbot_id=$1',[sibling])).rejects.toMatchObject({code:'23503'});
  await expect(pool.query('UPDATE handoff_requests SET organization_id=$1,chatbot_id=$2',[otherOrg,otherBot])).rejects.toMatchObject({code:'23503'});
  await expect(pool.query('UPDATE lead_capture_settings SET collect_email=false')).rejects.toMatchObject({code:'23514'});
  await expect(pool.query('UPDATE plans SET monthly_lead_limit=-1')).rejects.toMatchObject({code:'23514'});
  expect(h.status).toBe('requested');
});
it('safe defaults and public configuration expose only form fields',async()=>{
  expect((await service.settings(org,sibling)).enabled).toBe(false);
  const r=await request(app).get(`/api/public/chatbots/${publicId}/config`).set('Origin',origin).expect(200);
  expect(r.body.leadCapture).toEqual(SettingsSchema.parse({enabled:true,handoffEnabled:true}));
  for(const secret of [org,bot,user,'consentVersion','updated_by','created_at'])expect(r.text).not.toContain(secret);
});
it('owner/admin configure, member cannot mutate, settings validation and CSRF',async()=>{
  await auth('put','/lead-settings').send({enabled:true,collectEmail:false,requireEmail:true}).expect(400);
  await auth('put','/lead-settings').send({formTitle:'x'.repeat(121)}).expect(400);
  await request(app).put(base()+'/lead-settings').set('Cookie',cookie).send({}).expect(403);
  await pool.query("UPDATE organization_memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2",[org,user]);await settings();
  await pool.query("UPDATE organization_memberships SET role='member' WHERE organization_id=$1 AND user_id=$2",[org,user]);await auth('put','/lead-settings').send({}).expect(403);await auth('get','/lead-settings').expect(200);
});
it.each(['https://evil.example','http://localhost:4200/','null','http://localhost:42000'])('rejects nonexact Origin %s',async bad=>{await request(app).post(`/api/public/chatbots/${publicId}/leads`).set('Origin',bad).send(data()).expect(403);expect(await counts()).toEqual({leads:0,handoffs:0,usage:0});});
it('rejects missing origin, disabled bot and rotated public IDs',async()=>{
  await request(app).post(`/api/public/chatbots/${publicId}/leads`).send(data()).expect(403);
  await pool.query('UPDATE chatbots SET public_enabled=false WHERE id=$1',[bot]);await submit().expect(404);
  await pool.query("UPDATE chatbots SET public_enabled=true,public_id='pub_'||encode(gen_random_bytes(24),'hex') WHERE id=$1",[bot]);await submit().expect(404);
});
it('disabled capture/handoff block creation; payload limit and strict fields',async()=>{
  await settings({handoffEnabled:false});await submit(true,data({reason:'help'})).expect(403);
  await settings({enabled:false,handoffEnabled:false});await submit().expect(403);
  await settings();await submit(false,data({visitorMessage:'x'.repeat(14000)})).expect(413);await submit(false,data({history:[]})).expect(400);await submit(false,data({consentVersion:99})).expect(400);
  expect(await counts()).toEqual({leads:0,handoffs:0,usage:0});
});
it.each([{name:''},{email:''},{phone:''}])('enforces configured required field %j',async value=>{
  await settings({collectPhone:true,requirePhone:true,requireName:true});await submit(false,data({name:'Fixture',phone:'+123456789',...value})).expect(400);
});
it.each([{email:'bad'},{name:'x'.repeat(201)},{phone:'no phone'},{company:'x'.repeat(201)},{visitorMessage:'bad\u0000'}])('rejects invalid contact data %j',async value=>{await settings({collectPhone:true,collectCompany:true});await submit(false,data(value)).expect(400);expect((await counts()).usage).toBe(0);});
it('consent is explicit and version is server derived; email local part preserved',async()=>{
  const s=await settings({consentRequired:true,consentText:'May we contact you?'});await submit().expect(400);
  const r=await submit(false,data({email:'Lead@EXAMPLE.TEST',consentGiven:true})).expect(202);expect(r.body).toEqual({status:'accepted'});
  const lead=(await auth('get','/leads').expect(200)).body.items[0];expect(lead).toMatchObject({normalized_email:'Lead@example.test',consent_given:true,consent_version:s.body.consentVersion});expect(lead.consent_at).not.toBeNull();
  await settings({consentRequired:false});await submit().expect(202);const row=(await auth('get','/leads').expect(200)).body.items[0];expect(row.consent_given).toBe(false);expect(row.consent_at).toBeNull();
});
it('handoff requires contact and reason, creates both records and meters atomically',async()=>{
  await settings({requireEmail:false});await submit(true,data({email:undefined,reason:'Help'})).expect(400);await submit(true).expect(400);
  await handoff();expect(await counts()).toEqual({leads:1,handoffs:1,usage:2});
});
it.each([false,true])('idempotent concurrent retries meter once, separate keys do not merge email: %s',async h=>{
  const d=data(h?{reason:'Help'}:{});const responses=await Promise.all(Array.from({length:4},()=>submit(h,d)));expect(responses.map(r=>r.status)).toEqual([202,202,202,202]);
  expect(await counts()).toEqual({leads:1,handoffs:h?1:0,usage:h?2:1});await submit(h,data(h?{reason:'Help'}:{})).expect(202);expect((await counts()).leads).toBe(2);
});
it.each([false,true])('public rate limit returns Retry-After without consuming usage: %s',async h=>{
  const input=data(h?{reason:'Help'}:{});for(let i=0;i<(h?5:10);i++)await submit(h,input).expect(202);
  const r=await submit(h,input).expect(429);expect(r.body.error.code).toBe('RATE_LIMITED');expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);expect((await counts()).leads).toBe(1);
  const rows=JSON.stringify((await pool.query('SELECT * FROM rate_limit_windows')).rows);expect(rows).not.toContain('127.0.0.1');
});
it.each([false,true])('concurrent quota enforcement permits exactly two creations: %s',async h=>{
  await pool.query(`UPDATE plans SET ${h?'monthly_handoff_limit':'monthly_lead_limit'}=2`);
  const results=await Promise.all(Array.from({length:5},()=>submit(h,data(h?{reason:'help'}:{}))));expect(results.filter(r=>r.status===202)).toHaveLength(2);
  for(const r of results.filter(r=>r.status!==202))expect(r.body.error.code).toBe('QUOTA_EXCEEDED');expect(await counts()).toEqual({leads:2,handoffs:h?2:0,usage:h?4:2});
});
it('handoff lead quota and inactive/disabled entitlements roll back all work',async()=>{
  await pool.query('UPDATE plans SET monthly_lead_limit=0');await submit(true,data({reason:'help'})).expect(429);expect(await counts()).toEqual({leads:0,handoffs:0,usage:0});
  await pool.query('UPDATE plans SET monthly_lead_limit=100,human_handoff_enabled=false');await submit(true,data({reason:'help'})).expect(403);
  await pool.query('UPDATE plans SET lead_capture_enabled=false');await submit().expect(403);
  await pool.query("UPDATE organization_subscriptions SET status='suspended' WHERE organization_id=$1",[org]);await submit().expect(403);
});
it('lead status, bounded pagination, handoff details and deletion cascade survive downgrade',async()=>{
  const h=await handoff();await submit().expect(202);
  expect((await auth('get','/leads?limit=1').expect(200)).body.hasMore).toBe(true);await auth('get','/leads?limit=101').expect(400);await auth('get','/handoffs?status=bad').expect(400);
  await auth('patch',`/leads/${h.lead_id}`).send({status:'qualified'}).expect(200);expect((await auth('get','/leads?status=qualified').expect(200)).body.items).toHaveLength(1);
  await pool.query('UPDATE plans SET lead_capture_enabled=false');await auth('get',`/handoffs/${h.id}`).expect(200);
  await auth('delete',`/leads/${h.lead_id}`).expect(204);await auth('get',`/leads/${h.lead_id}`).expect(404);await auth('get',`/handoffs/${h.id}`).expect(404);expect((await counts()).handoffs).toBe(0);
});
it('workflow acknowledge/resolve/cancel and revision prevent stale or invalid transitions',async()=>{
  let h=await handoff();await auth('patch',`/handoffs/${h.id}`).send({revision:h.revision,action:'resolve'}).expect(409);
  h=(await auth('patch',`/handoffs/${h.id}`).send({revision:h.revision,action:'acknowledge'}).expect(200)).body;expect(h.acknowledged_at).not.toBeNull();
  await auth('patch',`/handoffs/${h.id}`).send({revision:1,action:'cancel'}).expect(409);
  h=(await auth('patch',`/handoffs/${h.id}`).send({revision:h.revision,action:'resolve'}).expect(200)).body;expect(h.resolved_at).not.toBeNull();
  await auth('patch',`/handoffs/${h.id}`).send({revision:h.revision,action:'assign',assignedUserId:user}).expect(409);
  const next=await handoff();expect((await auth('patch',`/handoffs/${next.id}`).send({revision:1,action:'cancel'}).expect(200)).body.status).toBe('cancelled');
});
it('assignment accepts same organization owner/admin/member and rejects foreign/nonexistent identically',async()=>{
  let h=await handoff();for(const id of [foreignUser,randomUUID()]){const r=await auth('patch',`/handoffs/${h.id}`).send({revision:h.revision,action:'assign',assignedUserId:id}).expect(404);expect(r.body.error.code).toBe('NOT_FOUND');}
  for(const id of [user,adminUser,member,null]){h=(await auth('patch',`/handoffs/${h.id}`).send({revision:h.revision,action:'assign',assignedUserId:id}).expect(200)).body;expect(h.assigned_user_id).toBe(id);}
});
it('simultaneous assignment permits one revision winner',async()=>{
  const h=await handoff();const rs=await Promise.all([user,member].map(id=>auth('patch',`/handoffs/${h.id}`).send({revision:1,action:'assign',assignedUserId:id})));expect(rs.map(r=>r.status).sort()).toEqual([200,409]);expect((await auth('get',`/handoffs/${h.id}`).expect(200)).body.assigned_user_id).toBe(rs.find(r=>r.status===200)!.body.assigned_user_id);
});
it('cross-organization and sibling chatbot IDOR return 404 for every read/mutation',async()=>{
  const h=await handoff();for(const [o,b] of [[otherOrg,otherBot],[org,sibling]])for(const [method,path,body] of [['get',`/leads/${h.lead_id}`,{}],['patch',`/leads/${h.lead_id}`,{status:'closed'}],['delete',`/leads/${h.lead_id}`,{}],['get',`/handoffs/${h.id}`,{}],['patch',`/handoffs/${h.id}`,{revision:1,action:'assign',assignedUserId:user}],['patch',`/handoffs/${h.id}`,{revision:1,action:'resolve'}]] as const){await request(app)[method](`/api/organizations/${o}/chatbots/${b}${path}`).set('Cookie',cookie).set('X-CSRF-Token',csrf).send(body).expect(404);}
  await request(app).get(`/api/organizations/${otherOrg}/chatbots/${otherBot}/lead-settings`).set('Cookie',cookie).expect(404);
  expect((await request(app).get(`/api/organizations/${org}/chatbots/${sibling}/leads`).set('Cookie',cookie).expect(200)).body.items).toEqual([]);
});
it('member read-only and all admin modifications require CSRF',async()=>{
  const h=await handoff();for(const [method,path,body] of [['patch',`/leads/${h.lead_id}`,{status:'closed'}],['delete',`/leads/${h.lead_id}`,{}],['patch',`/handoffs/${h.id}`,{revision:1,action:'acknowledge'}]] as const){await request(app)[method](base()+path).set('Cookie',cookie).send(body).expect(403);}
  await pool.query("UPDATE organization_memberships SET role='member' WHERE organization_id=$1 AND user_id=$2",[org,user]);await auth('get','/leads').expect(200);await auth('get','/handoffs').expect(200);await auth('patch',`/handoffs/${h.id}`).send({revision:1,action:'acknowledge'}).expect(403);await auth('delete',`/leads/${h.lead_id}`).expect(403);await auth('patch',`/leads/${h.lead_id}`).send({status:'closed'}).expect(403);
});
it('owner export includes M29, excludes secrets, reflects deletion, audits are PII-free',async()=>{
  const h=await handoff();const exportPath=`/api/organizations/${org}/privacy/export`;const get=()=>request(app).get(exportPath).set('Cookie',cookie);
  const r=await get().expect(200);expect(r.body.sections.leads.items).toHaveLength(1);expect(r.body.sections.handoffs.items).toHaveLength(1);expect(r.body.sections.leadSettings.items).toHaveLength(1);
  for(const forbidden of ['password_hash','csrf_hash','token_hash','secret_hash','key_hash','127.0.0.1',password])expect(r.text).not.toContain(forbidden);
  const audit=(await pool.query("SELECT action,metadata FROM audit_events WHERE organization_id=$1 AND (action LIKE 'lead%' OR action LIKE 'handoff%')",[org])).rows;
  expect(audit.map(r=>r.action)).toEqual(expect.arrayContaining(['lead_capture.settings_updated','lead.created','handoff.requested']));for(const a of audit)expect(a.metadata).toEqual({});
  await auth('delete',`/leads/${h.lead_id}`).expect(204);const clean=await get().expect(200);expect(clean.body.sections.leads.items).toEqual([]);expect(clean.body.sections.handoffs.items).toEqual([]);
  await request(app).get(`/api/organizations/${otherOrg}/privacy/export`).set('Cookie',cookie).expect(404);
  await pool.query("UPDATE organization_memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2",[org,user]);await get().expect(403);
});
it('deleted submissions retain PII-free retry protection without recreating data',async()=>{
  const d=data();await submit(false,d).expect(202);const l=(await auth('get','/leads').expect(200)).body.items[0];await auth('delete',`/leads/${l.id}`).expect(204);await submit(false,d).expect(202);expect(await counts()).toEqual({leads:0,handoffs:0,usage:1});
});
it('rolls back lead, usage, receipt and audits when handoff insertion fails',async()=>{
  await pool.query("CREATE FUNCTION reject_test_handoff() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER reject_test_handoff BEFORE INSERT ON handoff_requests FOR EACH ROW EXECUTE FUNCTION reject_test_handoff()");
  try{await submit(true,data({reason:'Help'})).expect(500);expect(await counts()).toEqual({leads:0,handoffs:0,usage:0});expect((await pool.query('SELECT count(*) FROM lead_submission_receipts')).rows[0].count).toBe('0');expect((await pool.query("SELECT count(*) FROM audit_events WHERE organization_id=$1 AND action='lead.created'",[org])).rows[0].count).toBe('0');}
  finally{await pool.query('DROP TRIGGER reject_test_handoff ON handoff_requests; DROP FUNCTION reject_test_handoff()');}
});
it('accepts phone-only configured callback and rejects unsolicited contact fields',async()=>{
  await settings({collectEmail:false,requireEmail:false,collectPhone:true,requirePhone:true});
  await submit(true,data({email:undefined,phone:'+91 (123) 456-7890',reason:'Please call'})).expect(202);
  await submit(true,data({phone:'+123456789',reason:'Please call'})).expect(400);
  const l=(await auth('get','/leads').expect(200)).body.items[0];expect(l.normalized_email).toBeNull();expect(l.phone).toBe('+91 (123) 456-7890');
});
it('expires receipt protection after 24h without storing plaintext keys',async()=>{
  const d=data();await submit(false,d).expect(202);const receipt=(await pool.query('SELECT key_hash FROM lead_submission_receipts')).rows[0];expect(receipt.key_hash).toMatch(/^[a-f0-9]{64}$/);expect(receipt.key_hash).not.toContain(d.idempotencyKey);
  await pool.query("UPDATE lead_submission_receipts SET expires_at=now()-interval '1 second'");await submit(false,d).expect(202);expect((await counts()).leads).toBe(2);
});
it('safe audit transitions record statuses and assignment IDs only',async()=>{
  const h=await handoff();await auth('patch',`/handoffs/${h.id}`).send({revision:1,action:'assign',assignedUserId:user}).expect(200);await auth('patch',`/leads/${h.lead_id}`).send({status:'contacted'}).expect(200);
  const rows=(await pool.query("SELECT action,metadata FROM audit_events WHERE organization_id=$1 AND action IN ('handoff.assigned','lead.status_updated') ORDER BY action",[org])).rows;
  expect(rows).toEqual([{action:'handoff.assigned',metadata:{status:'requested',assignedUserId:user}},{action:'lead.status_updated',metadata:{status:'contacted'}}]);
});
it('protected operational metrics report finite queue states and age without IDs or PII',async()=>{
  await handoff();const token=randomToken();const metricsApp=createApp({commercial,security,securityConfig:{...config,METRICS_ENABLED:true,METRICS_TOKEN:token}});
  await request(metricsApp).get('/internal/metrics').expect(404);const r=await request(metricsApp).get('/internal/metrics').set('Authorization',`Bearer ${token}`).expect(200);
  expect(r.text).toContain('north_orbital_handoffs{status="requested"} 1');expect(r.text).toContain('north_orbital_handoff_queue_age_seconds');for(const forbidden of [org,bot,'lead@example.test','Please help'])expect(r.text).not.toContain(forbidden);
});
