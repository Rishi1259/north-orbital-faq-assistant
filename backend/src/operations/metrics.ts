import { Counter, Histogram, Registry } from '@prometheus-io/client';
import type { RequestHandler } from 'express';
import type { SecurityConfig } from '../security/config.js';
import { safeEqual } from '../security/crypto.js';

export function createMetrics(config: SecurityConfig) {
  const registry = new Registry();
  const http = new Counter({ name: 'north_orbital_http_requests_total', help: 'HTTP requests by route class and status.', labelNames: ['route', 'status'], registers: [registry] });
  const duration = new Histogram({ name: 'north_orbital_http_duration_seconds', help: 'HTTP request duration.', labelNames: ['route'], registers: [registry], buckets: [0.01, 0.1, 0.5, 1, 5, 30, 120] });
  const events = new Counter({ name: 'north_orbital_security_events_total', help: 'Security and RAG outcomes.', labelNames: ['event'], registers: [registry] });
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
    res.type(registry.contentType).send(await registry.metrics());
  };
  return { middleware, endpoint, event: (event: 'rate_limit' | 'login_failure' | 'public_chat' | 'public_failure' | 'rag_fallback') => events.inc({ event }) };
}
export type Metrics = ReturnType<typeof createMetrics>;
