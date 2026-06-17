import { buildOpenApiDocument } from '../openapi.js';
import { assertOpenApiSchemaCoverage, OpenApiLikeDocument } from './schema-coverage.js';

type PublicOpenApiAudience = 'public' | 'admin';

const publicBaseUrl = 'https://api.acornops.dev';
const sessionCookieName = 'acornops_cp_session';
const allowedPublicPathPrefix = '/api/v1';
const allowedAdminPathPrefix = '/admin/v1';
const excludedPublicPaths = new Set(['/api/v1/auth/dev-login']);

function cloneDocument<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function operationCount(document: OpenApiLikeDocument): number {
  let count = 0;
  for (const pathItem of Object.values(document.paths)) {
    for (const method of Object.keys(pathItem)) {
      if (['get', 'post', 'patch', 'delete', 'put'].includes(method)) count += 1;
    }
  }
  return count;
}

function filterPaths(document: OpenApiLikeDocument, audience: PublicOpenApiAudience): void {
  for (const path of Object.keys(document.paths)) {
    const keep =
      audience === 'public'
        ? path.startsWith(allowedPublicPathPrefix) && !excludedPublicPaths.has(path)
        : path.startsWith(allowedAdminPathPrefix);
    if (!keep) {
      delete document.paths[path];
    }
  }
}

function assertNoForbiddenPaths(document: OpenApiLikeDocument, audience: PublicOpenApiAudience): void {
  const failures: string[] = [];
  for (const path of Object.keys(document.paths)) {
    if (path.startsWith('/internal/') || path === '/health' || path === '/ready' || path === '/metrics') {
      failures.push(`forbidden path exported: ${path}`);
    }
    if (audience === 'public') {
      if (!path.startsWith(allowedPublicPathPrefix)) failures.push(`path outside /api/v1 exported: ${path}`);
      if (excludedPublicPaths.has(path)) failures.push(`dev-only path exported: ${path}`);
    }
    if (audience === 'admin' && !path.startsWith(allowedAdminPathPrefix)) {
      failures.push(`non-admin path exported: ${path}`);
    }
  }
  if (operationCount(document) === 0) {
    failures.push(`no operations exported for ${audience} OpenAPI document`);
  }
  if (failures.length > 0) {
    throw new Error(`OpenAPI export validation failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

function normalizeDocument(document: OpenApiLikeDocument, audience: PublicOpenApiAudience): OpenApiLikeDocument {
  document.components.securitySchemes =
    audience === 'public'
      ? {
          userSession: document.components.securitySchemes.userSession,
          mattermostChatServiceToken: document.components.securitySchemes.mattermostChatServiceToken
        }
      : { adminBearer: document.components.securitySchemes.adminBearer };
  return document;
}

export function buildPublicOpenApiDocument(audience: PublicOpenApiAudience): OpenApiLikeDocument {
  const document = cloneDocument(buildOpenApiDocument(publicBaseUrl, sessionCookieName)) as unknown as OpenApiLikeDocument;
  filterPaths(document, audience);
  normalizeDocument(document, audience);
  assertNoForbiddenPaths(document, audience);
  assertOpenApiSchemaCoverage(document);
  return document;
}

export function assertPublicOpenApiDocument(document: OpenApiLikeDocument, audience: PublicOpenApiAudience): void {
  assertNoForbiddenPaths(document, audience);
  assertOpenApiSchemaCoverage(document);
}
