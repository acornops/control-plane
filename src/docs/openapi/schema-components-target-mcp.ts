import { dateTime, JsonSchema, jsonObject, schemaRef, stringArray, uuid } from './schema-types.js';

export function buildTargetMcpWireSchemas(): Record<string, JsonSchema> {
  return {
    TargetMcpToolConfig: {
      type: 'object',
      required: ['name', 'server_id', 'model_alias', 'mcp_server_url', 'timeout_ms', 'enabled'],
      properties: {
        name: { type: 'string' },
        server_id: uuid,
        model_alias: { type: 'string' },
        mcp_server_url: { type: 'string', format: 'uri' },
        timeout_ms: { type: 'integer', minimum: 0 },
        description: { type: 'string' },
        capability: { type: 'string', enum: ['read', 'write'] },
        version: { type: 'string' },
        source: { type: 'string', enum: ['mcp', 'builtin'] },
        input_schema: jsonObject,
        output_schema: jsonObject,
        artifact_policy: { type: 'string', enum: ['never', 'if_detailed', 'always'] },
        enabled: { type: 'boolean' },
        review_state: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        risk_level: { type: 'string', enum: ['read_only', 'non_destructive_write', 'high_risk', 'destructive'] },
        auto_allowed: { type: 'boolean' }
      },
      additionalProperties: true
    },
    TargetMcpServerConfig: {
      type: 'object',
      required: ['id', 'workspace_id', 'server_name', 'server_url', 'enabled', 'auth_type', 'credential_mode', 'tools'],
      properties: {
        id: uuid,
        workspace_id: uuid,
        target_id: uuid,
        target_type: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
        server_name: { type: 'string' },
        server_url: { type: 'string', format: 'uri' },
        enabled: { type: 'boolean' },
        auth_type: { type: 'string', enum: ['none', 'bearer_token', 'custom_header'] },
        credential_mode: { type: 'string', enum: ['none', 'workspace', 'individual'] },
        auth_header_name: { type: 'string' },
        auth_header_prefix: { type: 'string' },
        public_headers: { type: 'object', additionalProperties: { type: 'string' } },
        connection_status: { type: 'string', enum: ['unknown', 'ok', 'error'] },
        last_discovery_at: dateTime,
        last_discovery_error: { type: 'string', nullable: true },
        tools: { type: 'array', items: schemaRef('TargetMcpToolConfig') }
      },
      additionalProperties: true
    },
    TargetMcpServerList: {
      type: 'array',
      items: schemaRef('TargetMcpServerConfig')
    },
    TargetMcpTestConnection: {
      type: 'object',
      required: ['server_id', 'server_name', 'server_url', 'connection_status', 'last_discovery_at', 'discovered_tool_count', 'discovered_tools'],
      properties: {
        server_id: uuid,
        server_name: { type: 'string' },
        server_url: { type: 'string', format: 'uri' },
        connection_status: { type: 'string', enum: ['ok', 'error'] },
        last_discovery_at: dateTime,
        discovered_tool_count: { type: 'integer', minimum: 0 },
        discovered_tools: stringArray,
        error: { type: 'string' }
      },
      additionalProperties: true
    }
  };
}
