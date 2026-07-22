export type JsonSchema = Record<string, unknown>;

export type ReferenceObject = { $ref: string };

export type ResponseObject = {
  description?: string;
  content?: Record<string, unknown>;
};

export type OperationObject = {
  parameters?: unknown[];
  responses?: Record<string, ResponseObject | ReferenceObject>;
};

export type PathItemObject = Record<string, OperationObject>;

export interface OpenApiLikeDocument {
  paths: Record<string, PathItemObject>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: Record<string, unknown>;
    responses?: Record<string, ResponseObject>;
    parameters?: Record<string, unknown>;
    [group: string]: Record<string, unknown> | undefined;
  };
}

export const httpMethods = new Set(['get', 'post', 'patch', 'delete', 'put']);

export const uuid = { type: 'string', format: 'uuid' };
export const dateTime = { type: 'string', format: 'date-time' };
export const stringArray = { type: 'array', items: { type: 'string' } };
export const jsonObject = { type: 'object', additionalProperties: true };

export function schemaRef(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

export function pageOf(schemaName: string): JsonSchema {
  return {
    type: 'object',
    required: ['items'],
    properties: {
      items: { type: 'array', items: schemaRef(schemaName) },
      nextCursor: { type: 'string' }
    }
  };
}

export function statusResponse(schemaName: string): JsonSchema {
  return {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string' },
      message: { type: 'string' },
      ...refProperties(schemaName)
    },
    additionalProperties: true
  };
}

export function refProperties(name: string): Record<string, unknown> {
  const propertyName = name.charAt(0).toLowerCase() + name.slice(1);
  return { [propertyName]: schemaRef(name) };
}

export function jsonContent(schemaName: string): Record<string, unknown> {
  return {
    'application/json': {
      schema: schemaRef(schemaName)
    }
  };
}

export function streamContent(): Record<string, unknown> {
  return {
    'text/event-stream': {
      schema: { type: 'string', description: 'Server-Sent Events stream.' }
    }
  };
}
