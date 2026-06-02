import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildOpenApiDocument } from '../src/docs/openapi.js';
import { buildPublicOpenApiDocument } from '../src/docs/openapi/public-documents.js';
import { assertOpenApiSchemaCoverage } from '../src/docs/openapi/schema-coverage.js';

function operationKeys(document: { paths: Record<string, Record<string, unknown>> }): string[] {
  const keys: string[] = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of Object.keys(pathItem)) {
      if (['get', 'post', 'patch', 'delete', 'put'].includes(method)) {
        keys.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return keys.sort();
}

describe('public OpenAPI documents', () => {
  it('adds response schemas for externally documented success responses', () => {
    const document = buildOpenApiDocument('https://api.acornops.dev', 'acornops_cp_session');

    assert.doesNotThrow(() => assertOpenApiSchemaCoverage(buildPublicOpenApiDocument('public')));
    assert.doesNotThrow(() => assertOpenApiSchemaCoverage(buildPublicOpenApiDocument('admin')));
    assert.ok(Object.keys(document.components.schemas).includes('Workspace'));
    assert.ok(Object.keys(document.components.schemas).includes('AdminMutationResult'));
  });

  it('exports public API paths without internal, health, metrics, or dev-login routes', () => {
    const document = buildPublicOpenApiDocument('public');
    const keys = operationKeys(document);

    assert.ok(keys.length > 0);
    assert.ok(keys.every((key) => key.includes(' /api/v1/')));
    assert.equal(keys.includes('POST /api/v1/auth/dev-login'), false);
    assert.equal(keys.some((key) => key.includes('/internal/')), false);
    assert.equal(keys.some((key) => key.includes('/admin/v1/')), false);
    assert.equal(keys.some((key) => key.endsWith(' /health') || key.endsWith(' /ready') || key.endsWith(' /metrics')), false);
  });

  it('exports admin API paths separately from public browser-session paths', () => {
    const document = buildPublicOpenApiDocument('admin');
    const keys = operationKeys(document);

    assert.ok(keys.length > 0);
    assert.ok(keys.every((key) => key.includes(' /admin/v1/')));
    assert.ok(keys.includes('GET /admin/v1/me'));
    assert.ok(keys.includes('POST /admin/v1/tooling/sync'));
    assert.deepEqual(Object.keys(document.components.securitySchemes), ['adminBearer']);
  });
});
