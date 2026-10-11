import type { Pool, PoolClient } from 'pg';
import { notFound } from '../security/errors.js';
import { currentPeriod, type Plan, type Subscription } from './model.js';
export type DB = Pick<PoolClient,'query'>;
export class PlanRepository {
  constructor(private db: DB) {}
  async list() { return (await this.db.query<Plan>("SELECT * FROM plans WHERE status='active' ORDER BY monthly_message_limit,code")).rows; }
  async get(code: string) { const p = (await this.db.query<Plan>('SELECT * FROM plans WHERE code=$1',[code])).rows[0]; if (!p) throw notFound(); return p; }
}
export class SubscriptionRepository {
  constructor(private db: DB) {}
  async current(organizationId: string, now = new Date()) {
    const s = (await this.db.query<Subscription>('SELECT * FROM organization_subscriptions WHERE organization_id=$1 FOR UPDATE',[organizationId])).rows[0];
    if (!s) throw notFound();
    const period = currentPeriod(s.current_period_start,s.current_period_end,now);
    if (+period.start !== +s.current_period_start) {
      await this.db.query('UPDATE organization_subscriptions SET current_period_start=$2,current_period_end=$3,updated_at=now() WHERE organization_id=$1',
        [organizationId,period.start,period.end]);
      s.current_period_start = period.start; s.current_period_end = period.end;
    }
    return s;
  }
}
export async function transaction<T>(pool: Pool, work: (db: PoolClient)=>Promise<T>) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
  catch(e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}
