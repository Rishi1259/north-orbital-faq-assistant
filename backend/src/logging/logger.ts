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

          url:
            request.url,
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