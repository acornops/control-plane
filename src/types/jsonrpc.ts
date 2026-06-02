export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<JsonRpcRequest>;
  return v.jsonrpc === '2.0' && typeof v.method === 'string' && (typeof v.id === 'string' || typeof v.id === 'number');
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<JsonRpcResponse> & { method?: unknown };
  const hasResult = Object.prototype.hasOwnProperty.call(v, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(v, 'error');
  return (
    v.jsonrpc === '2.0' &&
    (typeof v.id === 'string' || typeof v.id === 'number') &&
    (hasResult || hasError) &&
    typeof v.method !== 'string'
  );
}

export function createSuccessResponse(id: string | number, result: unknown): JsonRpcSuccessResponse {
  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

export function createErrorResponse(id: string | number, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data }
  };
}
