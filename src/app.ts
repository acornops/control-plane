import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { csrfProtection } from './auth/csrf.js';
import { corsOriginOption } from './auth/origins.js';
import { config } from './config.js';
import { buildOpenApiDocument } from './docs/openapi.js';
import {
  renderSwaggerUiHtml,
  SWAGGER_UI_ASSET_BASE_PATH,
  SWAGGER_UI_ASSET_NAMES,
  swaggerUiAssetFile
} from './docs/swagger-ui.js';
import { checkDatabaseHealth } from './infra/db.js';
import { checkRedisHealth } from './infra/redis.js';
import { logger } from './logger.js';
import { renderControlPlaneMetrics } from './metrics.js';
import { agentsRouter } from './routes/agents.js';
import { adminRouter } from './routes/admin.js';
import { adminAuthRouter } from './routes/admin-auth.js';
import { authRouter } from './routes/auth.js';
import { internalExecutionRouter } from './routes/internal-execution.js';
import { runsRouter } from './routes/runs.js';
import { sessionsRouter } from './routes/sessions.js';
import { workspacesRouter } from './routes/workspaces.js';
import { workflowsRouter } from './routes/workflows.js';
import { webhooksRouter } from './routes/webhooks.js';
import { QuotaExceededError } from './store/repository-quotas.js';

const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const PERMISSIONS_POLICY = 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

function applySecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', API_CONTENT_SECURITY_POLICY);
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  next();
}

function docsContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'"
  ].join('; ');
}

export function createApp() {
  const app = express();
  const openApiDocument = buildOpenApiDocument(config.CONTROL_PLANE_BASE_URL, config.SESSION_COOKIE_NAME);

  app.set('trust proxy', config.TRUST_PROXY);
  app.use(cors({ origin: corsOriginOption(), credentials: true }));
  app.use(applySecurityHeaders);
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
    res.status(200).json({ status: 'ok', service: 'acornops-control-plane', version: '0.0.1-experimental.1' });
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

  app.get('/metrics', (_req, res) => {
    res.status(200).type('text/plain; version=0.0.4; charset=utf-8').send(renderControlPlaneMetrics());
  });

  if (config.ENABLE_API_DOCS) {
    for (const assetName of SWAGGER_UI_ASSET_NAMES) {
      app.get(`${SWAGGER_UI_ASSET_BASE_PATH}/${assetName}`, (_req, res) => {
        res.sendFile(swaggerUiAssetFile(assetName), { immutable: true, maxAge: '1y' });
      });
    }

    app.get('/openapi.json', (_req, res) => {
      res.status(200).json(openApiDocument);
    });

    app.get(['/docs', '/docs/'], (_req, res) => {
      const nonce = randomBytes(16).toString('base64');
      res.setHeader('Content-Security-Policy', docsContentSecurityPolicy(nonce));
      res.status(200).type('text/html').send(renderSwaggerUiHtml('/openapi.json', nonce));
    });
  }

  app.use('/api/v1', authRouter);
  app.use('/api/v1', agentsRouter);
  app.use('/api/v1', workspacesRouter);
  app.use('/api/v1', webhooksRouter);
  app.use('/api/v1', sessionsRouter);
  app.use('/api/v1', runsRouter);
  app.use('/api/v1', workflowsRouter);
  if (config.CONTROL_PLANE_ADMIN_API_ENABLED) {
    if (config.CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED) app.use('/admin-auth', adminAuthRouter);
    app.use('/admin/v1', adminRouter);
  }
  if (!config.INTERNAL_TRANSPORT_TLS_ENABLED) {
    app.use('/internal/v1', internalExecutionRouter);
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    if (err instanceof QuotaExceededError) {
      res.status(409).json({
        error: {
          code: 'QUOTA_EXCEEDED',
          message: err.message,
          retryable: false,
          details: {
            quotaKey: err.quotaKey,
            used: err.used,
            limit: err.limit
          }
        }
      });
      return;
    }
    logger.error({ err, requestId }, 'Unhandled application error');
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
