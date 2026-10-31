import { randomUUID } from 'node:crypto';
import { json, type Request, type RequestHandler } from 'express';
import { logger } from '../logger.js';

/** Keep parser-owned errors (which can contain the request body) out of logging. */
export function jsonBodyParser(): RequestHandler {
  const parse = json({
    limit: '4mb',
    verify: (req, _res, buffer) => {
      (req as Request & { rawBody?: string }).rawBody = buffer.toString('utf8');
    }
  });
  return (req, res, next) => {
    parse(req, res, (error: unknown) => {
      if (!error) { next(); return; }
      delete (req as Request & { rawBody?: string }).rawBody;
      const parserStatus = typeof error === 'object' && 'status' in error ? error.status : undefined;
      const status = parserStatus === 413 || parserStatus === 415 || parserStatus === 400 ? parserStatus : 500;
      const [code, message] = status === 413
        ? ['PAYLOAD_TOO_LARGE', 'Request body exceeds the size limit.']
        : status === 415
          ? ['UNSUPPORTED_MEDIA_TYPE', 'Request body encoding is unsupported.']
          : status === 400
            ? ['INVALID_REQUEST_BODY', 'Request body could not be parsed.']
            : ['INTERNAL_ERROR', 'Internal server error'];
      const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : randomUUID();
      // Do not serialize the exception, including its message, stack, or cause.
      logger.warn({ requestId, status, code }, 'HTTP body parser rejected request');
      res.setHeader('X-Request-Id', requestId);
      res.status(status).json({ error: { code, message, retryable: false, request_id: requestId } });
    });
  };
}
