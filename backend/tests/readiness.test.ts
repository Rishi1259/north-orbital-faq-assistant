import request from 'supertest';
import {
  describe,
  expect,
  it,
} from 'vitest';

import type {
  ModelProvider,
} from '../src/ai/types.js';

import {
  createApp,
} from '../src/app.js';

const unusedProvider: ModelProvider = {
  async generateAnswer() {
    throw new Error(
      'Readiness checks must not generate a chat answer.',
    );
  },
};

describe('GET /api/ready', () => {
  it('returns 200 when the application is ready', async () => {
    const response = await request(
      createApp({
        provider: unusedProvider,
        documentChunks: [],
        semanticIndex: null,
      }),
    )
      .get('/api/ready')
      .expect(200);

    expect(response.headers['content-type'])
      .toMatch(/json/);

    expect(response.body).toEqual(
      expect.objectContaining({
        status: expect.any(String),
      }),
    );
  });
});