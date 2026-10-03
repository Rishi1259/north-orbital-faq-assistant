import {
  randomUUID,
} from 'node:crypto';

import request from 'supertest';

import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createApp,
} from './authenticated-app.js';

import {
  ChatbotNotFoundError,
} from '../src/chatbots/errors.js';

describe(
  'tenant API',
  () => {
    it(
      'creates an organization',
      async () => {
        const organization = {
          id:
            randomUUID(),

          name:
            'Acme',

          slug:
            'acme',

          createdAt:
            new Date(),

          updatedAt:
            new Date(),
        };

        const organizationService = {
          create:
            vi.fn(
              async () =>
                organization,
            ),
        };

        const chatbotService = {};

        const app =
          createApp({
            organizationService:
              organizationService as never,

            chatbotService:
              chatbotService as never,
          });

        const response =
          await request(app)
            .post(
              '/api/organizations',
            )
            .send({
              name:
                'Acme',

              slug:
                'acme',
            });

        expect(
          response.status,
        ).toBe(201);

        expect(
          response.body
            .organization.id,
        ).toBe(
          organization.id,
        );
      },
    );

    it(
      'returns 400 for invalid organization input',
      async () => {
        const organizationService = {
          create:
            vi.fn(
              async () => {
                const {
                  z,
                } =
                  await import(
                    'zod'
                  );

                z.object({
                  slug:
                    z.string().min(2),
                }).parse({
                  slug: '',
                });
              },
            ),
        };

        const app =
          createApp({
            organizationService:
              organizationService as never,

            chatbotService:
              {} as never,
          });

        const response =
          await request(app)
            .post(
              '/api/organizations',
            )
            .send({});

        expect(
          response.status,
        ).toBe(400);

        expect(
          response.body.error.code,
        ).toBe(
          'INVALID_REQUEST',
        );
      },
    );

    it(
      'does not expose another tenant chatbot',
      async () => {
        const chatbotService = {
          getById:
            vi.fn(
              async () => {
                throw new ChatbotNotFoundError();
              },
            ),
        };

        const app =
          createApp({
            organizationService:
              {} as never,

            chatbotService:
              chatbotService as never,
          });

        const response =
          await request(app)
            .get(
              `/api/organizations/${randomUUID()}/chatbots/${randomUUID()}`,
            );

        expect(
          response.status,
        ).toBe(404);

        expect(
          response.body.error,
        ).toBe(
          'not_found',
        );
      },
    );
  },
);