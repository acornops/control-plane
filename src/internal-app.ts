import cookieParser from 'cookie-parser';
import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { csrfProtection } from './auth/csrf.js';
import { config } from './config.js';
import { checkDatabaseHealth } from './infra/db.js';
import { checkRedisHealth } from './infra/redis.js';
import { logger } from './logger.js';
import * as authController from './controllers/auth-controller.js';
import { adminAuthRouter } from './routes/admin-auth.js';
import { adminRouter } from './routes/admin.js';
import { internalExecutionRouter } from './routes/internal-execution.js';

export function createInternalApp() {
  const app = express();

  app.set('trust proxy', config.TRUST_PROXY);
  app.use((req, res, next) => {
    const requestId = req.header('x-request-id') || randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });
  app.use(express.json({
    limit: '4mb',
    verify: (req, _res, buffer) => {
      (req as Request & { rawBody?: string }).rawBody = buffer.toString('utf8');
    }
  }));
  app.use(cookieParser());
  app.use(csrfProtection);

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'acornops-control-plane-internal', version: '0.0.1-experimental.1' });
  });

  app.get('/ready', async (_req, res) => {
    const [dbReady, redisReady] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);
    if (dbReady && redisReady) {
      res.status(200).json({ status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' } });
      return;
    }
    res.status(503).json({
      status: 'degraded',
      dependencies: {
        postgres: dbReady ? 'ok' : 'down',
        redis: redisReady ? 'ok' : 'down'
      }
    });
  });

  app.get('/api/v1/auth/jwks.json', authController.jwks);
  app.use('/internal/v1', internalExecutionRouter);
  if (config.CONTROL_PLANE_ADMIN_API_ENABLED) {
    if (config.CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED) app.use('/admin-auth', adminAuthRouter);
    app.use('/admin/v1', adminRouter);
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    logger.error({ err, requestId }, 'Unhandled internal application error');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        retryable: false,
        request_id: requestId
      }
    });
  });

  return app;
}
