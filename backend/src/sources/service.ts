import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CommercialService } from '../commercial/service.js';
import { assertEntitled,QuotaError,type Plan,type Subscription } from '../commercial/model.js';
import type { DB } from '../commercial/repository.js';
import { appendAudit,type Audit } from '../security/repository.js';
import { HttpError,notFound } from '../security/errors.js';
import type { TenantScope } from '../rag/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { validateVector } from '../rag/repository.js';
import { normalizeUrl } from './url.js';
import { CrawlError,type CrawlerConfig } from './config.js';
import { hashContent } from './discovery.js';
export const WebsiteInput=z.object({url:z.string().min(1).max(2048),syncMode:z.enum(['manual','daily','weekly']).default('manual')}).strict();
export const WebsiteUpdate=z.object({syncMode:z.enum(['manual','daily','weekly']).optional(),disabled:z.boolean().optional()}).strict().refine(x=>Object.keys(x).length>0);
export const FaqInput=z.object({question:z.string().trim().min(1).max(500),answer:z.string().trim().min(1).max(8000),category:z.string().trim().max(100).default(''),revision:z.string().regex(/^[0-9]+$/).optional()}).strict();
export const scopeValues=(s:TenantScope)=>[s.organizationId,s.chatbotId];
export const sourceColumns=`s.id,s.canonical_seed_url,s.status,s.sync_mode,s.next_sync_at,s.last_attempted_at,s.last_successful_at,s.latest_error_code,s.created_at,s.updated_at,
  (SELECT count(*)::integer FROM website_pages p WHERE p.organization_id=s.organization_id AND p.chatbot_id=s.chatbot_id AND p.website_source_id=s.id AND p.state IN ('active','unchanged')) AS page_count,
  (SELECT state FROM website_crawl_jobs j WHERE j.organization_id=s.organization_id AND j.chatbot_id=s.chatbot_id AND j.website_source_id=s.id AND j.state IN ('queued','running') LIMIT 1) AS job_state`;
export class SourceService {
  constructor(readonly commercial:CommercialService,readonly embeddings:EmbeddingProvider,readonly config:CrawlerConfig){}
  get pool(){return this.commercial.pool;}
  async bot(db:DB,scope:TenantScope) {if(!(await db.query('SELECT id FROM chatbots WHERE organization_id=$1 AND id=$2',scopeValues(scope))).rowCount)throw notFound();}
  async inventory(db:DB,org:string) {
    return (await db.query(`SELECT
      (SELECT count(*)::integer FROM website_sources WHERE organization_id=$1) AS sources,
      ((SELECT count(*) FROM website_pages WHERE organization_id=$1 AND state IN ('active','unchanged'))+(SELECT count(*) FROM manual_faqs WHERE organization_id=$1))::integer AS pages,
      (SELECT coalesce(sum(octet_length(content)+4096),0)::float8 FROM knowledge_chunks WHERE organization_id=$1) AS bytes`,[org])).rows[0] as {sources:number;pages:number;bytes:number};
  }
  async capacity(db:DB,org:string,p:Plan,s:Subscription,pages=0,bytes=0,sources=0) {
    assertEntitled(s);const inventory=await this.inventory(db,org);
    if(inventory.sources+sources>p.website_source_limit || inventory.pages+pages>p.knowledge_page_limit || inventory.bytes+bytes>Number(p.indexed_bytes_limit))throw new QuotaError();
  }
  async list(scope:TenantScope,limit:number,offset:number) {await this.bot(this.pool,scope);return (await this.pool.query(`SELECT ${sourceColumns} FROM website_sources s WHERE s.organization_id=$1 AND s.chatbot_id=$2 ORDER BY s.created_at,s.id LIMIT $3 OFFSET $4`,[...scopeValues(scope),limit,offset])).rows;}
  async get(scope:TenantScope,id:string) {const row=(await this.pool.query(`SELECT ${sourceColumns} FROM website_sources s WHERE s.organization_id=$1 AND s.chatbot_id=$2 AND s.id=$3`,[...scopeValues(scope),id])).rows[0];if(!row)throw notFound();return row;}
  async pages(scope:TenantScope,id:string,limit:number,offset:number){await this.get(scope,id);return(await this.pool.query(`SELECT id,canonical_url,title,state,last_seen_at,indexed_at FROM website_pages WHERE organization_id=$1 AND chatbot_id=$2 AND website_source_id=$3 ORDER BY canonical_url,id LIMIT $4 OFFSET $5`,[...scopeValues(scope),id,limit,offset])).rows;}
  async enqueue(db:DB,scope:TenantScope,id:string){return(await db.query(`INSERT INTO website_crawl_jobs(organization_id,chatbot_id,website_source_id,max_attempts) VALUES($1,$2,$3,$4) ON CONFLICT(website_source_id) WHERE state IN ('queued','running') DO NOTHING RETURNING id`,[...scopeValues(scope),id,this.config.CRAWLER_MAX_ATTEMPTS])).rows[0];}
  async create(scope:TenantScope,input:z.infer<typeof WebsiteInput>,audit:Audit) {
    let url:URL;try{url=normalizeUrl(input.url);}catch{throw new HttpError(400,'INVALID_WEBSITE_URL','Enter a public HTTP or HTTPS URL without credentials.');}
    return this.commercial.run(scope.organizationId,async(db,{plan,subscription})=>{
      await this.bot(db,scope);await this.capacity(db,scope.organizationId,plan,subscription,0,0,1);
      const id=randomUUID();await db.query(`INSERT INTO website_sources(id,organization_id,chatbot_id,submitted_url,canonical_seed_url,scheme,host,port,allowed_origin,sync_mode,created_by) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10)`,[id,...scopeValues(scope),url.href,url.protocol,url.hostname,url.port,url.origin,input.syncMode,audit.actorUserId]);
      await this.enqueue(db,scope,id);await this.commercial.meter(db,subscription,'website_crawl_requests');
      await appendAudit(db,{...audit,...scope,targetId:id,action:'website_source.created',targetType:'website_source'});return {id};
    });
  }
  async sync(scope:TenantScope,id:string,audit:Audit) {return this.commercial.run(scope.organizationId,async(db,{subscription})=>{
    assertEntitled(subscription);const s=(await db.query('SELECT status FROM website_sources WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3 FOR UPDATE',[...scopeValues(scope),id])).rows[0];if(!s)throw notFound();if(s.status==='disabled')throw new HttpError(409,'SOURCE_DISABLED','Enable this source before syncing.');
    const job=await this.enqueue(db,scope,id);if(job){await this.commercial.meter(db,subscription,'website_crawl_requests');await appendAudit(db,{...audit,...scope,targetId:id,action:'website_source.sync_requested',targetType:'website_source'});}return {scheduled:true};
  });}
  async update(scope:TenantScope,id:string,input:z.infer<typeof WebsiteUpdate>,audit:Audit) {await this.commercial.run(scope.organizationId,async(db,{subscription})=>{
    assertEntitled(subscription);const result=await db.query(`UPDATE website_sources SET sync_mode=coalesce($4,sync_mode),status=CASE WHEN $5=true THEN 'disabled' WHEN $5=false AND status='disabled' THEN 'pending' ELSE status END,
      next_sync_at=CASE WHEN $5=true OR coalesce($4,sync_mode)='manual' THEN NULL ELSE now()+CASE WHEN coalesce($4,sync_mode)='daily' THEN interval '1 day' ELSE interval '7 days' END END,updated_at=now()
      WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3 RETURNING id`,[...scopeValues(scope),id,input.syncMode??null,input.disabled??null]);if(!result.rowCount)throw notFound();
    if(input.disabled)await db.query("DELETE FROM website_crawl_jobs WHERE organization_id=$1 AND chatbot_id=$2 AND website_source_id=$3 AND state IN ('queued','running')",[...scopeValues(scope),id]);
    await appendAudit(db,{...audit,...scope,targetId:id,action:'website_source.updated',targetType:'website_source'});
  });return this.get(scope,id);}
  async remove(scope:TenantScope,id:string,faq:boolean,audit:Audit){await this.commercial.run(scope.organizationId,async db=>{
    await this.bot(db,scope);const table=faq?'manual_faqs':'website_sources';const result=await db.query(`DELETE FROM ${table} WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3`,[...scopeValues(scope),id]);
    if(result.rowCount)await appendAudit(db,{...audit,...scope,targetId:id,action:faq?'manual_faq.deleted':'website_source.deleted',targetType:faq?'manual_faq':'website_source'});
  });}
  async faqs(scope:TenantScope,limit:number,offset:number,id?:string){await this.bot(this.pool,scope);const rows=(await this.pool.query(`SELECT id,question,answer,category,status,created_at,updated_at,xmin::text AS revision FROM manual_faqs WHERE organization_id=$1 AND chatbot_id=$2 AND ($5::uuid IS NULL OR id=$5) ORDER BY created_at,id LIMIT $3 OFFSET $4`,[...scopeValues(scope),limit,offset,id??null])).rows;if(id&&!rows.length)throw notFound();return rows;}
  async saveFaq(scope:TenantScope,input:z.infer<typeof FaqInput>,audit:Audit,id?:string){
    await this.bot(this.pool,scope);const previous=id?(await this.faqs(scope,1,0,id))[0]:undefined;
    if(id && input.revision && previous.revision!==input.revision)throw new HttpError(409,'SOURCE_CHANGED','This FAQ changed. Reload and try again.');
    const text=`Question: ${input.question}\nAnswer: ${input.answer}`;
    const [vector]=await this.embeddings.embed([text]);if(!vector)throw new CrawlError('EMBEDDING_FAILED',true);validateVector(vector);
    return this.commercial.run(scope.organizationId,async(db,{plan,subscription})=>{
      await this.bot(db,scope);const oldBytes=id?Number((await db.query('SELECT coalesce(sum(octet_length(content)+4096),0) AS bytes FROM knowledge_chunks WHERE organization_id=$1 AND chatbot_id=$2 AND faq_id=$3',[...scopeValues(scope),id])).rows[0].bytes):0;
      await this.capacity(db,scope.organizationId,plan,subscription,id?0:1,Buffer.byteLength(text)+4096-oldBytes);
      const faqId=id??randomUUID();
      if(id){const updated=await db.query(`UPDATE manual_faqs SET question=$4,answer=$5,category=$6,updated_at=now() WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3 AND xmin::text=$7 RETURNING id`,[...scopeValues(scope),id,input.question,input.answer,input.category,previous.revision]);if(!updated.rowCount)throw new HttpError(409,'SOURCE_CHANGED','This FAQ changed. Reload and try again.');}
      else await db.query('INSERT INTO manual_faqs(id,organization_id,chatbot_id,question,answer,category,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[faqId,...scopeValues(scope),input.question,input.answer,input.category,audit.actorUserId]);
      await db.query('DELETE FROM knowledge_chunks WHERE organization_id=$1 AND chatbot_id=$2 AND faq_id=$3',[...scopeValues(scope),faqId]);
      await db.query(`INSERT INTO knowledge_chunks(organization_id,chatbot_id,faq_id,chunk_index,content,content_hash,embedding,provider,model) VALUES($1,$2,$3,0,$4,$5,$6::vector,'ollama','qwen3-embedding:0.6b')`,[...scopeValues(scope),faqId,text,hashContent(text),JSON.stringify(vector)]);
      if(!id)await this.commercial.meter(db,subscription,'manual_faq_entries');
      await appendAudit(db,{...audit,...scope,targetId:faqId,action:id?'manual_faq.updated':'manual_faq.created',targetType:'manual_faq'});return {id:faqId};
    });
  }
}
