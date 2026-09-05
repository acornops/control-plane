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
    const adminDocument = buildPublicOpenApiDocument('admin');
    const adminUser = adminDocument.components.schemas.AdminUser as { allOf?: Array<{ properties?: Record<string, unknown> }> };
    const adminUserPage = adminDocument.components.schemas.AdminUserPage as { properties?: { items?: { items?: { $ref?: string } } } };
    assert.ok(adminUser.allOf?.some((schema) => schema.properties?.lastLoginAt));
    assert.equal(adminUserPage.properties?.items?.items?.$ref, '#/components/schemas/AdminUser');
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

  it('documents discriminated target MCP responses and retryable lifecycle deletion', () => {
    const document = buildPublicOpenApiDocument('public');
    const targetMcpServer = document.components.schemas.TargetMcpServerConfig as {
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.ok(targetMcpServer.required?.includes('scope_type'));
    assert.ok(targetMcpServer.required?.includes('target_id'));
    assert.ok(targetMcpServer.required?.includes('target_type'));
    assert.ok(targetMcpServer.properties?.scope_type);
    assert.equal(targetMcpServer.additionalProperties, false);

    const targetMcpCreate = document.paths['/api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers']?.post as {
      requestBody?: {
        content?: {
          'application/json'?: {
            schema?: {
              properties?: {
                url?: Record<string, unknown>;
                auth?: { properties?: Record<string, Record<string, unknown>> };
              };
            };
          };
        };
      };
    };
    const targetMcpProperties = targetMcpCreate.requestBody?.content?.['application/json']?.schema?.properties;
    const targetMcpUrl = targetMcpProperties?.url;
    assert.equal(targetMcpUrl?.format, 'uri');
    assert.equal(targetMcpUrl?.pattern, '^https://');
    assert.match(String(targetMcpUrl?.description), /fragments.*query keys/i);
    assert.equal(targetMcpProperties?.auth?.properties?.headerName?.maxLength, 128);
    assert.match(String(targetMcpProperties?.auth?.properties?.headerName?.pattern), /A-Za-z/);
    assert.equal(targetMcpProperties?.auth?.properties?.headerPrefix?.maxLength, 4096);
    assert.match(String(targetMcpProperties?.auth?.properties?.headerPrefix?.description), /CR.*LF/i);

    const agentMcpCreate = document.paths['/api/v1/workspaces/{workspaceId}/agents/{agentId}/mcp/servers']?.post as {
      requestBody?: {
        content?: {
          'application/json'?: {
            schema?: {
              properties?: Record<string, Record<string, unknown>>;
            };
          };
        };
      };
    };
    const agentMcpProperties = agentMcpCreate.requestBody?.content?.['application/json']?.schema?.properties;
    assert.equal(agentMcpProperties?.authHeaderName?.maxLength, 128);
    assert.equal(
      agentMcpProperties?.authHeaderName?.pattern,
      targetMcpProperties?.auth?.properties?.headerName?.pattern
    );
    assert.equal(agentMcpProperties?.authHeaderPrefix?.maxLength, 4096);

    const vmDelete = document.paths['/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}']?.delete as {
      responses?: Record<string, unknown>;
    };
    const workspaceDelete = document.paths['/api/v1/workspaces/{workspaceId}']?.delete as {
      responses?: Record<string, unknown>;
    };
    assert.ok(vmDelete.responses?.['503']);
    assert.ok(workspaceDelete.responses?.['503']);
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
