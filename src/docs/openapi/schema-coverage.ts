import { buildSharedOpenApiSchemas } from './schema-components.js';
import { schemaForOperation } from './response-schema-map.js';
import {
  httpMethods,
  jsonContent,
  OpenApiLikeDocument,
  OperationObject,
  streamContent
} from './schema-types.js';

export type { OpenApiLikeDocument } from './schema-types.js';

function addDefaultErrorResponses(operation: OperationObject): void {
  operation.responses ??= {};
  for (const code of ['400', '401', '403', '404', '409', '429', '500']) {
    operation.responses[code] ??= { description: 'Error response.' };
    operation.responses[code].content ??= jsonContent('ErrorResponse');
  }
}

function addSuccessResponseSchema(method: string, path: string, operation: OperationObject): void {
  if (!operation.responses) return;

  for (const [statusCode, response] of Object.entries(operation.responses)) {
    if (!statusCode.startsWith('2')) continue;
    if (response.content) continue;
    if (statusCode === '204') continue;
    if (
      method === 'get' &&
      (
        path === '/api/v1/runs/{runId}/stream' ||
        path === '/api/v1/workspaces/{workspaceId}/targets/{targetId}/chat-activity/stream'
      )
    ) {
      response.content = streamContent();
      continue;
    }
    const schemaName = schemaForOperation(method, path, statusCode);
    if (schemaName) {
      response.content = jsonContent(schemaName);
    }
  }
}

export function enrichOpenApiDocument<T extends OpenApiLikeDocument>(document: T): T {
  document.components.schemas = {
    ...document.components.schemas,
    ...buildSharedOpenApiSchemas()
  };

  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!httpMethods.has(method)) continue;
      addSuccessResponseSchema(method, path, operation);
      if (path.startsWith('/api/v1') || path.startsWith('/admin/v1')) {
        addDefaultErrorResponses(operation);
      }
    }
  }

  return document;
}

export function assertOpenApiSchemaCoverage(document: OpenApiLikeDocument): void {
  const failures: string[] = [];

  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!httpMethods.has(method)) continue;
      for (const [statusCode, response] of Object.entries(operation.responses ?? {})) {
        if (!statusCode.startsWith('2')) continue;
        if (statusCode === '204' || statusCode === '302') continue;
        if (!response.content) {
          failures.push(`${method.toUpperCase()} ${path} ${statusCode} is missing response content`);
        }
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`OpenAPI schema coverage failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}
