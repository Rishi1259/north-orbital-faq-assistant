import type { Pool } from 'pg';
import { appendAudit } from '../security/repository.js';
import { HttpError, notFound } from '../security/errors.js';
import { assertEntitled, entitlements, MetricSchema, quota, QuotaError, type Metric, type Plan, type Subscription } from './model.js';
import { PlanRepository, SubscriptionRepository, transaction, type DB } from './repository.js';
export class CommercialService {
  constructor(readonly pool: Pool) {}
  async locked(db: DB, org: string) {
    // Universal lock order: organization, subscription, then resources/jobs.
    if (!(await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[org])).rowCount) throw notFound();
    const now: Date = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
    const subscription = await new SubscriptionRepository(db).current(org,now);
    const plan = await new PlanRepository(db).get(subscription.plan_code);
    return { subscription, plan, entitlements: entitlements(subscription,plan,now) };
  }
  async run<T>(org: string, work: (db: DB, state: Awaited<ReturnType<CommercialService['locked']>>)=>Promise<T>) {
    try { return await transaction(this.pool,async db => work(db,await this.locked(db,org))); }
    catch(e) {
      if (e instanceof QuotaError) await appendAudit(this.pool,{ organizationId: org, action:'quota.exceeded', targetType:'organization', metadata:{result:'failure'} });
      throw e;
    }
  }
  async inventory(db: DB, org: string) {
    const r = (await db.query(`SELECT
      (SELECT count(*) FROM website_sources WHERE organization_id=$1)::text AS websites,
      ((SELECT count(*) FROM website_pages WHERE organization_id=$1 AND state IN ('active','unchanged'))+(SELECT count(*) FROM manual_faqs WHERE organization_id=$1))::text AS knowledge_pages,
      (SELECT coalesce(sum(octet_length(content)+4096),0) FROM knowledge_chunks WHERE organization_id=$1)::text AS indexed_bytes,
      (SELECT count(*) FROM chatbots WHERE organization_id=$1)::text AS chatbots,
      (SELECT count(*) FROM organization_memberships WHERE organization_id=$1)::text AS members,
      ((SELECT count(*) FROM documents WHERE organization_id=$1)+(SELECT count(*) FROM object_cleanup_jobs WHERE organization_id=$1 AND purpose='upload'))::text AS documents,
      ((SELECT coalesce(sum(size_bytes),0) FROM documents WHERE organization_id=$1)+(SELECT coalesce(sum(size_bytes),0) FROM object_cleanup_jobs WHERE organization_id=$1))::text AS bytes`,[org])).rows[0];
    return {websites:Number(r.websites),knowledgePages:Number(r.knowledge_pages),indexedBytes:Number(r.indexed_bytes),chatbots:Number(r.chatbots), members:Number(r.members), documents:Number(r.documents), bytes:Number(r.bytes)};
  }
  async checkResource(db: DB, org: string, s: Subscription, p: Plan, resource: 'chatbots'|'members'|'documents', bytes = 0) {
    assertEntitled(s);
    const inventory = await this.inventory(db,org);
    const limit = resource === 'chatbots' ? p.chatbot_limit : resource === 'members' ? p.team_member_limit : p.document_limit;
    if (inventory[resource]+1 > limit || (resource === 'documents' && inventory.bytes+bytes > Number(p.storage_bytes_limit))) throw new QuotaError();
  }
  async meter(db: DB, s: Subscription, metric: Metric, amount = 1) {
    MetricSchema.parse(metric);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid usage amount.');
    await db.query(`INSERT INTO usage_counters(organization_id,metric,period_start,period_end,quantity)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,metric,period_start)
      DO UPDATE SET quantity=usage_counters.quantity+EXCLUDED.quantity,updated_at=now()`,
      [s.organization_id,metric,s.current_period_start,s.current_period_end,amount]);
  }
  async consumeMessage(org: string, metric: 'public_chat_messages'|'internal_chat_messages', api = false) {
    return this.run(org,async(db,{subscription:s,plan:p})=>{
      assertEntitled(s);
      if (api && !p.api_access) throw new HttpError(403,'API_ACCESS_DISABLED','API access is not included in this plan.');
      const used = Number((await db.query(`SELECT coalesce(sum(quantity),0) AS n FROM usage_counters
        WHERE organization_id=$1 AND period_start=$2 AND metric IN ('public_chat_messages','internal_chat_messages')`,[org,s.current_period_start])).rows[0].n);
      // Public and internal traffic share the plan message allowance, so neither can bypass it.
      if (used >= p.monthly_message_limit) throw new QuotaError();
      await this.meter(db,s,metric);
    });
  }
  async apiRequest(org: string) {
    return this.run(org,async(db,{subscription:s,plan:p})=>{
      assertEntitled(s); if (!p.api_access) throw new HttpError(403,'API_ACCESS_DISABLED','API access is not included in this plan.');
      await this.meter(db,s,'api_requests');
    });
  }
  async snapshot(org: string) { return this.run(org,(db,state)=>this.snapshotWithin(db,org,state)); }
  async snapshotWithin(db: DB, org: string, state: Awaited<ReturnType<CommercialService['locked']>>) {
    const {subscription:s,plan:p} = state, inventory = await this.inventory(db,org);
    const rows = (await db.query('SELECT metric,quantity FROM usage_counters WHERE organization_id=$1 AND period_start=$2',[org,s.current_period_start])).rows;
    const used = Object.fromEntries(rows.map(r=>[r.metric,Number(r.quantity)]));
    const messages = (used.public_chat_messages??0)+(used.internal_chat_messages??0);
    return { organization: (await db.query('SELECT id,name,slug,created_at FROM organizations WHERE id=$1',[org])).rows[0],
      subscription:s,plan:p,entitlements:state.entitlements, period:{start:s.current_period_start,end:s.current_period_end},
      usage:{websiteSources:quota(inventory.websites,p.website_source_limit),knowledgePages:quota(inventory.knowledgePages,p.knowledge_page_limit),indexedBytes:quota(inventory.indexedBytes,Number(p.indexed_bytes_limit)),
        websitePagesIndexed:quota(used.website_pages_indexed??0,null),websiteCrawlRequests:quota(used.website_crawl_requests??0,null),manualFaqEntries:quota(used.manual_faq_entries??0,null),messages:quota(messages,p.monthly_message_limit),
        publicChatMessages:quota(used.public_chat_messages??0,null),internalChatMessages:quota(used.internal_chat_messages??0,null),
        chatbots:quota(inventory.chatbots,p.chatbot_limit),documents:quota(inventory.documents,p.document_limit),
        storageBytes:quota(inventory.bytes,Number(p.storage_bytes_limit)),members:quota(inventory.members,p.team_member_limit),
        documentsCreated:quota(used.documents_created??0,null),uploadedBytes:quota(used.storage_bytes??0,null),
        ingestionPages:quota(used.ingestion_pages??0,p.monthly_ingestion_page_limit),apiRequests:quota(used.api_requests??0,null)} };
  }
}
