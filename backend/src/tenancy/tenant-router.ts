import type { SecurityStore } from '../security/repository.js';
import { auditContext } from '../security/http.js';
import {
  Router,
  type Response,
} from 'express';

import {
  ZodError,
} from 'zod';

import {
  logger,
} from '../logging/logger.js';

import {
  ChatbotNotFoundError,
} from '../chatbots/errors.js';

import type {
  ChatbotService,
} from '../chatbots/chatbot-service.js';

import {
  OrganizationNotFoundError,
  OrganizationSlugTakenError,
} from '../organizations/errors.js';

import type {
  OrganizationService,
} from '../organizations/organization-service.js';

interface TenantRouterOptions {
  security?: SecurityStore;
  organizationService: OrganizationService;
  chatbotService: ChatbotService;
}

function sendError(
  response: Response,
  error: unknown,
): void {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: 'invalid_request',
      issues: error.issues.map(
        (issue) => ({
          path:
            issue.path.join('.'),

          message:
            issue.message,
        }),
      ),
    });

    return;
  }

  if (
    error instanceof
    OrganizationSlugTakenError
  ) {
    response.status(409).json({
      error:
        'organization_slug_taken',

      message:
        error.message,
    });

    return;
  }

  if (
    error instanceof
      OrganizationNotFoundError ||
    error instanceof
      ChatbotNotFoundError
  ) {
    response.status(404).json({
      error:
        'not_found',

      message:
        error.message,
    });

    return;
  }

  logger.error(
    { failure: 'tenant_api' },
    'Unhandled tenant API error',
  );

  response.status(500).json({
    error:
      'internal_server_error',
  });
}

export function createTenantRouter(
  options: TenantRouterOptions,
): Router {
  const router =
    Router();

  router.post(
    '/organizations',
    async (
      request,
      response,
    ) => {
      try {
        const organization =
          await options
            .organizationService
            .create(
              request.body,
            );

        response.status(201).json({
          organization,
        });
      } catch (error) {
        sendError(
          response,
          error,
        );
      }
    },
  );

  router.get(
    '/organizations/:organizationId',
    async (
      request,
      response,
    ) => {
      try {
        const organization =
          await options
            .organizationService
            .getById(
              request.params
                .organizationId,
            );

        response.json({
          organization,
        });
      } catch (error) {
        sendError(
          response,
          error,
        );
      }
    },
  );

  router.post(
    '/organizations/:organizationId/chatbots',
    async (
      request,
      response,
    ) => {
      try {
        const chatbot =
          await options
            .chatbotService
            .create(
              request.params
                .organizationId,

              request.body,
            );

        if (options.security) await options.security.audit({ ...auditContext(request, response, 'chatbot.created', 'chatbot'),
          organizationId: request.params.organizationId, chatbotId: chatbot.id, targetId: chatbot.id });
        response.status(201).json({
          chatbot,
        });
      } catch (error) {
        sendError(
          response,
          error,
        );
      }
    },
  );

  router.get(
    '/organizations/:organizationId/chatbots',
    async (
      request,
      response,
    ) => {
      try {
        const chatbots =
          await options
            .chatbotService
            .listByOrganization(
              request.params
                .organizationId,
            );

        response.json({
          chatbots,
        });
      } catch (error) {
        sendError(
          response,
          error,
        );
      }
    },
  );

  router.get(
    '/organizations/:organizationId/chatbots/:chatbotId',
    async (
      request,
      response,
    ) => {
      try {
        const chatbot =
          await options
            .chatbotService
            .getById(
              request.params
                .organizationId,

              request.params
                .chatbotId,
            );

        response.json({
          chatbot,
        });
      } catch (error) {
        sendError(
          response,
          error,
        );
      }
    },
  );

  return router;
}