import { randomUUID } from 'node:crypto';
import { transaction } from '../commercial/repository.js';
import { assertEntitled,QuotaError } from '../commercial/model.js';
import { appendAudit } from '../security/repository.js';
import { CrawlError } from './config.js';
import { crawl,type CrawlResult,type StoredPage } from './crawl.js';
import { SourceService,scopeValues } from './service.js';
import type { Transport } from './http.js';
export interface CrawlJob {id:string;organization_id:string;chatbot_id:string;website_source_id:string;worker_id:string;attempts:number;max_attempts:number}
const jobScope=(j:CrawlJob)=>({organizationId:j.organization_id,chatbotId:j.chatbot_id});
export class CrawlJobs {
  constructor(readonly sources:SourceService){}
  async schedule() {
    const due=(await this.sources.pool.query(`SELECT organization_id,chatbot_id,id FROM website_sources WHERE next_sync_at<=now() AND sync_mode<>'manual' AND status<>'disabled' AND NOT EXISTS(SELECT 1 FROM website_crawl_jobs j WHERE j.website_source_id=website_sources.id AND j.state IN ('queued','running')) ORDER BY next_sync_at,id LIMIT 20`)).rows;
    for(const row of due)try{await this.sources.sync({organizationId:row.organization_id,chatbotId:row.chatbot_id},row.id,{action:'website_source.sync_requested',targetType:'website_source'});}catch(e){if(!(e instanceof Error && 'status' in e))throw e;}
  }
  async recover(){
    const stale=(await this.sources.pool.query("SELECT id,organization_id,chatbot_id,website_source_id FROM website_crawl_jobs WHERE state='running' AND lease_at<now()-interval '60 seconds' ORDER BY lease_at LIMIT 20")).rows;
    let recovered=0;
    for(const row of stale)await this.sources.commercial.run(row.organization_id,async db=>{
      await db.query('SELECT id FROM website_sources WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3 FOR UPDATE',[row.organization_id,row.chatbot_id,row.website_source_id]);
      const result=await db.query(`UPDATE website_crawl_jobs SET state=CASE WHEN attempts<max_attempts THEN 'queued' ELSE 'failed' END,
        worker_id=NULL,lease_at=NULL,available_at=now()+interval '30 seconds',completed_at=CASE WHEN attempts>=max_attempts THEN now() ELSE NULL END,error_code='LEASE_EXPIRED'
        WHERE id=$1 AND organization_id=$2 AND chatbot_id=$3 AND state='running' AND lease_at<now()-interval '60 seconds' RETURNING id`,[row.id,row.organization_id,row.chatbot_id]);
      if(!result.rowCount)return;
      recovered++;
      await db.query(`UPDATE website_sources SET status='failed',latest_error_code='LEASE_EXPIRED',latest_error_at=now(),next_sync_at=CASE sync_mode WHEN 'daily' THEN now()+interval '1 day' WHEN 'weekly' THEN now()+interval '7 days' ELSE NULL END WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3 AND status='syncing'`,[row.organization_id,row.chatbot_id,row.website_source_id]);
    });
    return recovered;
  }
  async prune(){
    await this.sources.pool.query("DELETE FROM website_crawl_jobs WHERE id IN (SELECT id FROM website_crawl_jobs WHERE state IN ('successful','failed') AND completed_at<now()-interval '30 days' ORDER BY completed_at LIMIT 100)");
    await this.sources.pool.query("DELETE FROM website_pages WHERE id IN (SELECT id FROM website_pages WHERE state='removed' AND removed_at<now()-interval '30 days' ORDER BY removed_at LIMIT 100)");
  }
  async claim(){return transaction(this.sources.pool,async db=>{
    const job=(await db.query<CrawlJob>(`UPDATE website_crawl_jobs SET state='running',attempts=attempts+1,worker_id=$1,lease_at=now(),started_at=now()
      WHERE id=(SELECT j.id FROM website_crawl_jobs j JOIN website_sources s ON s.organization_id=j.organization_id AND s.chatbot_id=j.chatbot_id AND s.id=j.website_source_id
        WHERE j.state='queued' AND j.available_at<=now() AND j.attempts<j.max_attempts AND s.status<>'disabled' ORDER BY j.available_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING *`,[randomUUID()])).rows[0];
    // Source status is updated separately by process() under the universal org
    // lock, avoiding job->source / source->job deadlocks with deletion.
    return job;
  });}
  async heartbeat(job:CrawlJob){return (await this.sources.pool.query("UPDATE website_crawl_jobs SET lease_at=now() WHERE id=$1 AND organization_id=$2 AND chatbot_id=$3 AND state='running' AND worker_id=$4",[job.id,job.organization_id,job.chatbot_id,job.worker_id])).rowCount===1;}
  async finish(job:CrawlJob,result:CrawlResult){
    const scope=jobScope(job),sourceId=job.website_source_id;
    return this.sources.commercial.run(scope.organizationId,async(db,{plan,subscription})=>{
      const source=(await db.query('SELECT id FROM website_sources WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3 AND status<>\'disabled\' FOR UPDATE',[...scopeValues(scope),sourceId])).rows[0];if(!source)return false;
      const fence=await db.query("SELECT id FROM website_crawl_jobs WHERE id=$1 AND organization_id=$2 AND chatbot_id=$3 AND state='running' AND worker_id=$4 FOR UPDATE",[job.id,job.organization_id,job.chatbot_id,job.worker_id]);if(!fence.rowCount)return false;
      assertEntitled(subscription);
      let indexed=0;
      for(const page of result.pages) {
        const old=(await db.query('SELECT id,state FROM website_pages WHERE organization_id=$1 AND chatbot_id=$2 AND website_source_id=$3 AND canonical_url=$4',[...scopeValues(scope),sourceId,page.url])).rows[0];
        if(page.removed){if(old){await db.query("UPDATE website_pages SET state='removed',removed_at=now(),last_seen_at=now(),http_status=$5 WHERE organization_id=$1 AND chatbot_id=$2 AND website_source_id=$3 AND id=$4",[...scopeValues(scope),sourceId,old.id,page.status]);await db.query('DELETE FROM knowledge_chunks WHERE organization_id=$1 AND chatbot_id=$2 AND website_source_id=$3 AND page_id=$4',[...scopeValues(scope),sourceId,old.id]);}continue;}
        const pageId=old?.id??randomUUID();
        await db.query(`INSERT INTO website_pages(id,organization_id,chatbot_id,website_source_id,canonical_url,path,title,content_type,http_status,content_hash,etag,last_modified,state,links,indexed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()) ON CONFLICT(organization_id,chatbot_id,website_source_id,canonical_url) DO UPDATE SET
          title=EXCLUDED.title,content_type=EXCLUDED.content_type,http_status=EXCLUDED.http_status,content_hash=EXCLUDED.content_hash,etag=EXCLUDED.etag,last_modified=EXCLUDED.last_modified,
          state=EXCLUDED.state,links=EXCLUDED.links,last_seen_at=now(),removed_at=NULL,updated_at=now(),indexed_at=CASE WHEN $15 THEN website_pages.indexed_at ELSE now() END`,
          [pageId,...scopeValues(scope),sourceId,page.url,new URL(page.url).pathname,page.title,page.mime,page.status,page.hash,page.etag,page.modified,page.unchanged?'unchanged':'active',page.links,page.unchanged]);
        if(!page.unchanged){
          await db.query('DELETE FROM knowledge_chunks WHERE organization_id=$1 AND chatbot_id=$2 AND website_source_id=$3 AND page_id=$4',[...scopeValues(scope),sourceId,pageId]);
          for(const [index,chunk] of page.chunks.entries())await db.query(`INSERT INTO knowledge_chunks(organization_id,chatbot_id,website_source_id,page_id,chunk_index,content,content_hash,embedding,provider,model)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8::vector,'ollama','qwen3-embedding:0.6b')`,[...scopeValues(scope),sourceId,pageId,index,chunk.text,chunk.hash,JSON.stringify(chunk.vector)]);
          indexed++;
        }
      }
      if(result.complete){
        const removed=await db.query(`UPDATE website_pages SET state='removed',removed_at=now(),updated_at=now() WHERE organization_id=$1 AND chatbot_id=$2 AND website_source_id=$3 AND state IN ('active','unchanged') AND NOT(canonical_url=ANY($4::text[])) RETURNING id`,[...scopeValues(scope),sourceId,result.pages.map(p=>p.url)]);
        await db.query('DELETE FROM knowledge_chunks WHERE organization_id=$1 AND chatbot_id=$2 AND website_source_id=$3 AND page_id=ANY($4::uuid[])',[...scopeValues(scope),sourceId,removed.rows.map(p=>p.id)]);
      }
      // Check final inventory inside the same organization lock/transaction.
      // Any excess rolls back ALL replacements, removals, counters and state.
      await this.sources.capacity(db,scope.organizationId,plan,subscription);
      const bounds=(await db.query(`SELECT (SELECT count(*) FROM website_pages WHERE organization_id=$1 AND chatbot_id=$2 AND website_source_id=$3 AND state IN ('active','unchanged')) AS pages,
        (SELECT count(*) FROM knowledge_chunks WHERE organization_id=$1 AND chatbot_id=$2 AND website_source_id=$3) AS chunks`,[...scopeValues(scope),sourceId])).rows[0];
      if(Number(bounds.pages)>this.sources.config.CRAWLER_MAX_PAGES_PER_SOURCE || Number(bounds.chunks)>this.sources.config.CRAWLER_MAX_CHUNKS_PER_SOURCE)throw new CrawlError('SOURCE_LIMIT');
      const used=Number((await db.query("SELECT coalesce(sum(quantity),0) AS n FROM usage_counters WHERE organization_id=$1 AND period_start=$2 AND metric='ingestion_pages'",[scope.organizationId,subscription.current_period_start])).rows[0].n);
      if(plan.monthly_ingestion_page_limit!==null && used+indexed>plan.monthly_ingestion_page_limit)throw new QuotaError();
      await this.sources.commercial.meter(db,subscription,'website_pages_indexed',indexed);await this.sources.commercial.meter(db,subscription,'ingestion_pages',indexed);
      await db.query(`UPDATE website_sources SET status='ready',last_successful_at=now(),last_completed_run_id=$4,latest_error_code=NULL,latest_error_at=NULL,updated_at=now(),
        next_sync_at=CASE sync_mode WHEN 'daily' THEN now()+interval '1 day' WHEN 'weekly' THEN now()+interval '7 days' ELSE NULL END WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3`,[...scopeValues(scope),sourceId,job.id]);
      await db.query("UPDATE website_crawl_jobs SET state='successful',completed_at=now(),lease_at=NULL,worker_id=NULL,pages_processed=$2 WHERE id=$1 AND organization_id=$3 AND chatbot_id=$4",[job.id,result.pages.length,scope.organizationId,scope.chatbotId]);
      await appendAudit(db,{...scope,action:'website_source.sync_completed',targetType:'website_source',targetId:sourceId,metadata:{count:result.pages.length}});return true;
    });
  }
  async fail(job:CrawlJob,error:unknown){
    const scope=jobScope(job);const failure=error instanceof CrawlError?error:new CrawlError(error instanceof QuotaError?'QUOTA_EXCEEDED':'CRAWL_FAILED',!(error instanceof QuotaError));
    return this.sources.commercial.run(scope.organizationId,async db=>{
      const source=(await db.query('SELECT id FROM website_sources WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3 FOR UPDATE',[...scopeValues(scope),job.website_source_id])).rows[0];if(!source)return;
      const retry=failure.retryable&&job.attempts<job.max_attempts;
      const updated=await db.query(`UPDATE website_crawl_jobs SET state=$5,available_at=now()+$6*interval '1 second',lease_at=NULL,worker_id=NULL,error_code=$7,completed_at=CASE WHEN $5='failed' THEN now() ELSE NULL END
        WHERE id=$1 AND organization_id=$2 AND chatbot_id=$3 AND worker_id=$4 AND state='running' RETURNING id`,[job.id,job.organization_id,job.chatbot_id,job.worker_id,retry?'queued':'failed',Math.max(failure.retryAfter,Math.min(3600,30*2**(job.attempts-1))),failure.code]);
      if(!updated.rowCount)return;
      await db.query(`UPDATE website_sources SET status='failed',latest_error_code=$4,latest_error_at=now(),updated_at=now(),next_sync_at=CASE sync_mode WHEN 'daily' THEN now()+interval '1 day' WHEN 'weekly' THEN now()+interval '7 days' ELSE NULL END WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3 AND status<>'disabled'`,[...scopeValues(scope),job.website_source_id,failure.code]);
      await appendAudit(db,{...scope,action:'website_source.sync_failed',targetType:'website_source',targetId:job.website_source_id,metadata:{result:'failure'}});
    });
  }
  async process(job:CrawlJob,transport?:Transport){
    const scope=jobScope(job);let heartbeat:ReturnType<typeof setInterval>|undefined;
    try{
      const source=await this.sources.commercial.run(scope.organizationId,async(db,{subscription})=>{
        assertEntitled(subscription);
        const row=(await db.query(`UPDATE website_sources SET status='syncing',last_attempted_at=now() WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3 AND status<>'disabled'
          AND EXISTS(SELECT 1 FROM website_crawl_jobs WHERE id=$4 AND worker_id=$5 AND state='running') RETURNING canonical_seed_url`,[...scopeValues(scope),job.website_source_id,job.id,job.worker_id])).rows[0];return row;
      });if(!source)return;
      heartbeat=setInterval(()=>{void this.heartbeat(job).catch(()=>{});},15000);heartbeat.unref();
      const existing=(await this.sources.pool.query<StoredPage>('SELECT id,canonical_url,content_hash,etag,last_modified,links,state,title FROM website_pages WHERE organization_id=$1 AND chatbot_id=$2 AND website_source_id=$3',[...scopeValues(scope),job.website_source_id])).rows;
      const result=await crawl(source.canonical_seed_url,existing,this.sources.config,this.sources.embeddings,transport);return await this.finish(job,result);
    }catch(error){await this.fail(job,error);return false;}finally{if(heartbeat)clearInterval(heartbeat);}
  }
}
