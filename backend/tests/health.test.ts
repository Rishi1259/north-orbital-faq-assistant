import request from 'supertest';

import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  ModelProvider,
} from '../src/ai/types.js';

import {
  createApp,
} from '../src/app.js';

function createFakeProvider():
  ModelProvider {
  return {
    generateAnswer:
      vi.fn(async () => ({
        canAnswer: false,
        answer: '',
        sourceIds: [],
      })),
  };
}

describe(
  'health and readiness',
  () => {
    it(
      'returns healthy when the application is alive',
      async () => {
        const response =
          await request(
            createApp({
              provider:
                createFakeProvider(),

              documentChunks: [],

              semanticIndex:
                null,
            }),
          )
            .get('/api/health')
            .expect(200);

        expect(
          response.body,
        ).toEqual({
          status: 'ok',

          service:
            'north-orbital-faq-assistant',

          documentChunks: 0,
        });
      },
    );

    it(
      'returns ready when dependencies are available',
      async () => {
        const readinessCheck =
          vi.fn(
            async () => {},
          );

        const response =
          await request(
            createApp({
              provider:
                createFakeProvider(),

              documentChunks: [],

              semanticIndex:
                null,

              readinessCheck,
            }),
          )
            .get('/api/ready')
            .expect(200);

        expect(
          response.body,
        ).toEqual({
          status: 'ready',

          service:
            'north-orbital-faq-assistant',
        });

        expect(
          readinessCheck,
        ).toHaveBeenCalledTimes(
          1,
        );
      },
    );

    it(
      'returns not ready when a dependency fails',
      async () => {
        const readinessCheck =
          vi.fn(
            async () => {
              throw new Error(
                'Database unavailable.',
              );
            },
          );

        const consoleError =
          vi
            .spyOn(
              console,
              'error',
            )
            .mockImplementation(
              () => {},
            );

        try {
          const response =
            await request(
              createApp({
                provider:
                  createFakeProvider(),

                documentChunks: [],

                semanticIndex:
                  null,

                readinessCheck,
              }),
            )
              .get('/api/ready')
              .expect(503);

          expect(
            response.body,
          ).toEqual({
            status:
              'not_ready',

            service:
              'north-orbital-faq-assistant',
          });

          expect(
            readinessCheck,
          ).toHaveBeenCalledTimes(
            1,
          );

          expect(
  response.headers[
    'x-request-id'
  ],
).toMatch(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);
        } finally {
          consoleError
            .mockRestore();
        }
      },
    );
  },
);