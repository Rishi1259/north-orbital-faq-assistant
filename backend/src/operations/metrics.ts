import type { Pool } from 'pg';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { RequestHandler } from 'express';
import type { SecurityConfig } from '../security/config.js';
import { safeEqual } from '../security/crypto.js';

export function createMetrics(config: SecurityConfig, database?: Pick<Pool,'query'>) {
  const registry = new Registry();
  const http = new Counter({ name: 'north_orbital_http_requests_total', help: 'HTTP requests by route class and status.', labelNames: ['route', 'status'], registers: [registry] });
  const duration = new Histogram({ name: 'north_orbital_http_duration_seconds', help: 'HTTP request duration.', labelNames: ['route'], registers: [registry], buckets: [0.01, 0.1, 0.5, 1, 5, 30, 120] });
  const events = new Counter({ name: 'north_orbital_security_events_total', help: 'Security and RAG outcomes.', labelNames: ['event'], registers: [registry] });
  const crawlCounts=new Gauge({name:'north_orbital_crawl_jobs',help:'Retained durable crawl jobs by finite state.',labelNames:['state'],registers:[registry]});
  const queueAge=new Gauge({name:'north_orbital_crawl_queue_age_seconds',help:'Oldest due queued crawl age.',registers:[registry]});
  const pages=new Gauge({name:'north_orbital_crawl_pages_processed',help:'Pages processed in retained successful runs.',registers:[registry]});
  const middleware: RequestHandler = (req, res, next) => {
    // Fixed route classes only: never label with paths, IDs, filenames or query strings.
    const route = req.path.startsWith('/api/public/') ? 'public' : req.path.startsWith('/api/auth/') ? 'auth' :
      req.path.startsWith('/api/organizations') ? 'admin' : req.path.startsWith('/widget/') ? 'widget' : 'operations';
    const start = performance.now();
    res.on('finish', () => { http.inc({ route, status: String(res.statusCode) }); duration.observe({ route }, (performance.now() - start) / 1000); });
    next();
  };
  const endpoint: RequestHandler = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!config.METRICS_ENABLED || !config.METRICS_TOKEN || !safeEqual(req.get('authorization') ?? '', `Bearer ${config.METRICS_TOKEN}`)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } }); return;
    }
    if(database){
      const rows=(await database.query("SELECT state,count(*)::float8 AS n FROM website_crawl_jobs GROUP BY state")).rows;
      for(const state of ['queued','running','successful','failed'])crawlCounts.set({state},rows.find(r=>r.state===state)?.n??0);
      const aggregates=(await database.query(`SELECT coalesce(max(extract(epoch FROM now()-available_at)) FILTER(WHERE state='queued' AND available_at<=now()),0)::float8 age,
        coalesce(sum(pages_processed) FILTER(WHERE state='successful'),0)::float8 pages FROM website_crawl_jobs`)).rows[0];
      queueAge.set(aggregates.age);pages.set(aggregates.pages);
    }
    res.type(registry.contentType).send(await registry.metrics());
  };
  return { middleware, endpoint, event: (event: 'rate_limit' | 'login_failure' | 'public_chat' | 'public_failure' | 'rag_fallback') => events.inc({ event }) };
}
export type Metrics = ReturnType<typeof createMetrics>;
