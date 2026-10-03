import {
  randomUUID,
} from 'node:crypto';

import pino from 'pino';

import {
  pinoHttp,
} from 'pino-http';

const logLevel =
  process.env.NODE_ENV === 'test'
    ? 'silent'
    : process.env.LOG_LEVEL ?? 'info';

export const logger =
  pino({
    level: logLevel,

    base: {
      service:
        'north-orbital-faq-assistant',

      environment:
        process.env.NODE_ENV ??
        'development',
    },

    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'password', 'password_hash', 'token', 'csrfToken', 'sessionToken',
        'OBJECT_STORAGE_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_KEY', 'RATE_LIMIT_HASH_SECRET', 'METRICS_TOKEN',
        'req.body', 'body',
        'res.headers["set-cookie"]',
      ],

      remove: true,
    },
  });

export const requestLogger =
  pinoHttp({
    logger,

    genReqId(
      _request,
      response,
    ) {
      const requestId =
        randomUUID();

      response.setHeader(
        'X-Request-Id',
        requestId,
      );

      return requestId;
    },

    serializers: {
      req(request) {
        return {
          id:
            request.id,

          method:
            request.method,


        };
      },

      res(response) {
        return {
          statusCode:
            response.statusCode,
        };
      },
    },
  });