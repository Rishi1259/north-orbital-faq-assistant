import {
  randomUUID,
} from 'node:crypto';

import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  ChatbotNotFoundError,
} from '../src/chatbots/errors.js';

import {
  ChatbotService,
} from '../src/chatbots/chatbot-service.js';

import {
  OrganizationNotFoundError,
  OrganizationSlugTakenError,
} from '../src/organizations/errors.js';

import {
  OrganizationService,
} from '../src/organizations/organization-service.js';

function organization(
  overrides = {},
) {
  return {
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

    ...overrides,
  };
}

describe(
  'OrganizationService',
  () => {
    it(
      'creates a valid organization',
      async () => {
        const created =
          organization();

        const repository = {
          findBySlug:
            vi.fn(
              async () =>
                null,
            ),

          create:
            vi.fn(
              async () =>
                created,
            ),
        };

        const service =
          new OrganizationService(
            repository as never,
          );

        const result =
          await service.create({
            name:
              'Acme',

            slug:
              'acme',
          });

        expect(result).toEqual(
          created,
        );

        expect(
          repository.create,
        ).toHaveBeenCalledWith({
          name:
            'Acme',

          slug:
            'acme',
        });
      },
    );

    it(
      'rejects duplicate slugs',
      async () => {
        const repository = {
          findBySlug:
            vi.fn(
              async () =>
                organization(),
            ),

          create:
            vi.fn(),
        };

        const service =
          new OrganizationService(
            repository as never,
          );

        await expect(
          service.create({
            name:
              'Acme',

            slug:
              'acme',
          }),
        ).rejects.toBeInstanceOf(
          OrganizationSlugTakenError,
        );
      },
    );
  },
);

describe(
  'ChatbotService',
  () => {
    it(
      'creates a chatbot only for an existing organization',
      async () => {
        const org =
          organization();

        const chatbot = {
          id:
            randomUUID(),

          organizationId:
            org.id,

          name:
            'Support Bot',

          status:
            'draft' as const,

          createdAt:
            new Date(),

          updatedAt:
            new Date(),
        };

        const organizations = {
          findById:
            vi.fn(
              async () =>
                org,
            ),
        };

        const chatbots = {
          create:
            vi.fn(
              async () =>
                chatbot,
            ),
        };

        const service =
          new ChatbotService(
            organizations as never,
            chatbots as never,
          );

        const result =
          await service.create(
            org.id,
            {
              name:
                'Support Bot',
            },
          );

        expect(result).toEqual(
          chatbot,
        );
      },
    );

    it(
      'rejects chatbot creation for a missing organization',
      async () => {
        const organizations = {
          findById:
            vi.fn(
              async () =>
                null,
            ),
        };

        const chatbots = {
          create:
            vi.fn(),
        };

        const service =
          new ChatbotService(
            organizations as never,
            chatbots as never,
          );

        await expect(
          service.create(
            randomUUID(),
            {
              name:
                'Support Bot',
            },
          ),
        ).rejects.toBeInstanceOf(
          OrganizationNotFoundError,
        );

        expect(
          chatbots.create,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'does not return another tenant chatbot',
      async () => {
        const chatbots = {
          findById:
            vi.fn(
              async () =>
                null,
            ),
        };

        const service =
          new ChatbotService(
            {} as never,
            chatbots as never,
          );

        await expect(
          service.getById(
            randomUUID(),
            randomUUID(),
          ),
        ).rejects.toBeInstanceOf(
          ChatbotNotFoundError,
        );
      },
    );
  },
);