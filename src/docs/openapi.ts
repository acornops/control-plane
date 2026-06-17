import { buildAuthPaths } from './openapi/auth-paths.js';
import { buildAdminPaths } from './openapi/admin-paths.js';
import { buildClusterPaths } from './openapi/cluster-paths.js';
import { buildHealthPaths } from './openapi/health-paths.js';
import { buildInternalPaths } from './openapi/internal-paths.js';
import { buildSessionRunPaths } from './openapi/session-run-paths.js';
import { buildTargetPaths } from './openapi/target-paths.js';
import { buildVirtualMachinePaths } from './openapi/virtual-machine-paths.js';
import { buildWebhookPaths } from './openapi/webhook-paths.js';
import { buildWorkspacePaths } from './openapi/workspace-paths.js';
import { enrichOpenApiDocument, OpenApiLikeDocument } from './openapi/schema-coverage.js';

interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, unknown>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
}

export function buildOpenApiDocument(baseUrl: string, sessionCookieName: string): OpenApiDocument {
  const exampleReturnTo = 'http://console.acornops.localhost:8088/';
  const exampleRedirectUri = 'http://console.acornops.localhost:8088/api/v1/auth/oidc/callback';
  const exampleServerUrl = 'https://mcp.example.com/';

  const document: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: 'AcornOps Control Plane API',
      version: '0.0.1-experimental.1',
      description: 'Control plane API for workspaces, targets, Kubernetes clusters, virtual machines, sessions, runs, auth, and internal execution wiring.'
    },
    servers: [{ url: baseUrl }],
    tags: [
      { name: 'health', description: 'Health and readiness endpoints.' },
      { name: 'auth', description: 'OIDC, password, browser session, and external integration account link endpoints.' },
      { name: 'workspaces', description: 'Workspace, target, Kubernetes cluster, and VM management endpoints.' },
      { name: 'webhooks', description: 'Best-effort webhook subscription and delivery history endpoints.' },
      { name: 'sessions', description: 'Session and message endpoints.' },
      { name: 'runs', description: 'Run query, cancel, and stream endpoints.' },
      { name: 'admin', description: 'Operator-only admin API protected exclusively by admin bearer tokens.' },
      { name: 'internal', description: 'Internal execution endpoints for execution-engine.' }
    ],
    paths: {
      ...buildHealthPaths(),
      ...buildAuthPaths(exampleReturnTo, exampleRedirectUri),
      ...buildWorkspacePaths(),
      ...buildWebhookPaths(),
      ...buildTargetPaths(exampleServerUrl),
      ...buildClusterPaths(),
      ...buildVirtualMachinePaths(),
      ...buildSessionRunPaths(),
      ...buildAdminPaths(),
      ...buildInternalPaths()
    },
    components: {
      securitySchemes: {
        userSession: {
          type: 'apiKey',
          in: 'cookie',
          name: sessionCookieName
        },
        serviceToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'opaque'
        },
        externalIntegrationServiceToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'opaque external integration service token'
        },
        gatewayRunToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        },
        adminBearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'opaque admin token'
        }
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                retryable: { type: 'boolean' },
                details: {
                  type: 'object',
                  additionalProperties: true,
                  description: 'Optional structured error details. QUOTA_EXCEEDED includes quotaKey, used, and limit.'
                }
              }
            }
          }
        }
      }
    }
  };

  return enrichOpenApiDocument(document as unknown as OpenApiLikeDocument) as unknown as OpenApiDocument;
}
