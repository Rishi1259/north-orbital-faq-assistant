import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';

describe('GET /api/health', () => {
  it('returns the backend health status', async () => {
    const response = await request(createApp())
      .get('/api/health')
      .expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      service: 'north-orbital-faq-assistant',
    });
  });
});
