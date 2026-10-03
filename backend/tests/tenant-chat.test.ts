import { fakeRepository } from './rag-fixtures.js';
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
} from '../src/app.js';

import {
  ChatbotNotFoundError,
} from '../src/chatbots/errors.js';

describe(
  'tenant-scoped chat',
  () => {
    it(
      'verifies the tenant chatbot before chatting',
      async () => {
        const organizationId =
          randomUUID();

        const chatbotId =
          randomUUID();

        const chatbotService = {
          getById:
            vi.fn(
              async () => ({
                id:
                  chatbotId,

                organizationId,

                name:
                  'Support Bot',

                status:
                  'draft',

                createdAt:
                  new Date(),

                updatedAt:
                  new Date(),
              }),
            ),
        };

        const provider = {
          generateAnswer:
            vi.fn(),
        };

        const app =
          createApp({
            retrievalRepository: fakeRepository(),
            embeddingProvider: { embed: async () => [] },
            provider:
              provider as never,

            chatbotService:
              chatbotService as never,

            documentChunks: [],
            semanticIndex: null,
          });

        await request(app)
          .post(
            `/api/organizations/${organizationId}/chatbots/${chatbotId}/chat`,
          )
          .send({
            message:
              'Do you repair bicycles?',

            history: [],
          });

        expect(
          chatbotService.getById,
        ).toHaveBeenCalledWith(
          organizationId,
          chatbotId,
        );
      },
    );

    it(
      'returns 404 for a chatbot belonging to another tenant',
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
            retrievalRepository: fakeRepository(),
            embeddingProvider: { embed: async () => [] },
            chatbotService:
              chatbotService as never,

            documentChunks: [],
            semanticIndex: null,
          });

        const response =
          await request(app)
            .post(
              `/api/organizations/${randomUUID()}/chatbots/${randomUUID()}/chat`,
            )
            .send({
              message:
                'What are your opening hours?',

              history: [],
            });

        expect(
          response.status,
        ).toBe(404);

        expect(
          response.body.error.code,
        ).toBe(
          'CHATBOT_NOT_FOUND',
        );
      },
    );
  },
);