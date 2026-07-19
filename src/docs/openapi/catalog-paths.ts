import { EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

const workspaceId = {
  in: 'path', name: 'workspaceId', required: true,
  schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
};
const agentId = { in: 'path', name: 'agentId', required: true, schema: { type: 'string' } };
const targetId = { in: 'path', name: 'targetId', required: true, schema: { type: 'string' } };
const serverId = { in: 'path', name: 'serverId', required: true, schema: { type: 'string', format: 'uuid' } };
const toolName = { in: 'path', name: 'toolName', required: true, schema: { type: 'string' } };
const skillId = { in: 'path', name: 'skillId', required: true, schema: { type: 'string', format: 'uuid' } };
const serviceIdentityId = { in: 'path', name: 'serviceIdentityId', required: true, schema: { type: 'string' } };
const artifactId = { in: 'path', name: 'artifactId', required: true, schema: { type: 'string', format: 'uuid' } };
const sourceId = { in: 'path', name: 'sourceId', required: true, schema: { type: 'string', format: 'uuid' } };

const importBody = {
  required: true,
  content: { 'application/json': { schema: {
    type: 'object', required: ['artifact', 'version', 'remoteEndpoint'],
    properties: {
      artifact: { type: 'object', properties: {
        artifactId: { type: 'string', format: 'uuid' }, sourceId: { type: 'string', format: 'uuid' }, artifactName: { type: 'string' }
      }, additionalProperties: false },
      version: { type: 'string' },
      remoteEndpoint: { type: 'string', description: 'Selected Streamable HTTP endpoint URL or registry URL template.' },
      serverName: { type: 'string' }, enabled: { type: 'boolean' },
      publicHeaders: { type: 'object', additionalProperties: { type: 'string' } },
      endpointConfiguration: { type: 'object', additionalProperties: { type: 'string' } },
      expectedRevision: { type: 'integer', minimum: 1, description: 'Required only for explicit reimport.' },
      targetConstraints: { type: 'object', properties: {
        targetTypes: { type: 'array', items: { type: 'string', enum: ['kubernetes', 'virtual_machine'] } },
        targetIds: { type: 'array', items: { type: 'string' } }
      }, additionalProperties: false }
    }, additionalProperties: false
  } } }
};

const connectionBody = {
  required: true,
  content: { 'application/json': { schema: {
    type: 'object', required: ['credential', 'consentGranted'], properties: {
      credential: { type: 'string', minLength: 1, maxLength: 8192, writeOnly: true, description: 'Maximum 8 KiB as UTF-8. Control characters are rejected and the value is stored without normalization.' },
      consentGranted: { type: 'boolean', enum: [true] }
    }, additionalProperties: false
  } } }
};

const connectionResponse = {
  description: 'Secret-free connection status.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/McpUserConnectionResponse' } } }
};

const connectionErrors = {
  '400': { description: 'Invalid PAT payload or missing consent.' },
  '401': { description: 'A current user session is required.' },
  '403': { description: 'Destination read or run capability is missing.' },
  '404': { description: 'Installation not found.' },
  '409': { description: 'Installation does not use a personal connection.' },
  '429': { description: 'Connection operation throttled. Retry-After is returned.' },
  '502': { description: 'Remote discovery failed.' },
  '503': { description: 'The credential service is unavailable.' }
};

const manualAgentMcpBody = {
  required: true,
  content: { 'application/json': { schema: {
    type: 'object',
    required: ['name', 'url'],
    properties: {
      name: { type: 'string' },
      url: { type: 'string', format: 'uri', pattern: '^https://', description: 'Actual remote Streamable HTTP MCP endpoint. Registry, server.json, package, container, and stdio locations are rejected.' },
      enabled: { type: 'boolean' },
      authType: { type: 'string', enum: ['none', 'bearer_token', 'custom_header'] },
      authHeaderName: { type: 'string' },
      authHeaderPrefix: { type: 'string' },
      publicHeaders: { type: 'object', additionalProperties: { type: 'string' } },
      targetConstraints: {
        type: 'object',
        properties: {
          targetTypes: { type: 'array', items: { type: 'string', enum: ['kubernetes', 'virtual_machine'] } },
          targetIds: { type: 'array', items: { type: 'string', format: 'uuid' } }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  } } }
};

function connectionPaths(parameters: unknown[]) {
  return {
    get: { tags: ['catalog'], summary: 'Read the current user personal MCP connection status', security: [{ userSession: [] }], parameters, responses: { '200': connectionResponse, ...connectionErrors } },
    put: { tags: ['catalog'], summary: 'Connect or replace the current user MCP PAT', description: 'Requires destination read access and a supported run capability. The installation determines bearer or custom-header formatting. The PAT is write-only and authenticated tool discovery records connected or error status.', security: [{ userSession: [] }], parameters, requestBody: connectionBody, responses: { '200': connectionResponse, ...connectionErrors } },
    delete: { tags: ['catalog'], summary: 'Disconnect the current user MCP PAT', description: 'Idempotent. Requires destination read access and a supported run capability.', security: [{ userSession: [] }], parameters, responses: { '204': { description: 'Connection absent.' }, ...connectionErrors } }
  };
}

function verifyConnectionPath(parameters: unknown[]) {
  return { post: {
    tags: ['catalog'],
    summary: 'Retry verification of the stored current-user MCP PAT',
    security: [{ userSession: [] }], parameters,
    responses: { '200': connectionResponse, ...connectionErrors }
  } };
}

export function buildCatalogPaths(): Record<string, unknown> {
  const agentConnection = [workspaceId, agentId, serverId];
  const targetConnection = [workspaceId, targetId, serverId];
  return {
    '/api/v1/workspaces/{workspaceId}/service-identities': {
      get: { tags: ['agents'], summary: 'List delegated service identities', security: [{ userSession: [] }], parameters: [workspaceId], responses: { '200': { description: 'Secret-free service identities.' } } },
      post: { tags: ['agents'], summary: 'Create a delegated service identity', description: 'Requires manage_agents. Service identities cannot use the owner role.', security: [{ userSession: [] }], parameters: [workspaceId], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'role'], properties: { name: { type: 'string' }, role: { type: 'string' } }, additionalProperties: false } } } }, responses: { '201': { description: 'Service identity created.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/service-identities/{serviceIdentityId}': {
      patch: { tags: ['agents'], summary: 'Update or disable a delegated service identity', security: [{ userSession: [] }], parameters: [workspaceId, serviceIdentityId], responses: { '200': { description: 'Service identity updated.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/catalog/sources': {
      get: { tags: ['catalog'], summary: 'List workspace MCP registries', security: [{ userSession: [] }], parameters: [workspaceId], responses: { '200': { description: 'Secret-free MCP registries and source-management capabilities.' } } },
      post: { tags: ['catalog'], summary: 'Create a workspace MCP registry', description: 'Requires manage_catalog_sources. AcornOps probes the HTTPS registry root before persistence and appends /v0.1.', security: [{ userSession: [] }], parameters: [workspaceId], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['displayName', 'baseUrl'], properties: { displayName: { type: 'string' }, baseUrl: { type: 'string', format: 'uri', pattern: '^https://', description: 'Registry root or path prefix without /v0.1, query parameters, fragments, or credentials.' }, enabled: { type: 'boolean' }, networkRoute: { type: 'string', enum: ['direct'] }, auth: { type: 'object', properties: { type: { type: 'string', enum: ['none', 'bearer_token', 'custom_header'] }, credential: { type: 'string', writeOnly: true }, headerName: { type: 'string' } }, additionalProperties: false } }, additionalProperties: false } } } }, responses: { '201': { description: 'MCP registry created, probed, and synchronized.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/catalog/sources/{sourceId}': {
      patch: { tags: ['catalog'], summary: 'Update a workspace MCP registry', description: 'Requires manage_catalog_sources. Omitted auth preserves the credential; auth type none clears it; other auth replacements require a new write-only credential. URL and authentication changes are probed before persistence and trigger a full synchronization. Deployment-managed registries reject configuration changes.', security: [{ userSession: [] }], parameters: [workspaceId, sourceId], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', minProperties: 1, properties: { displayName: { type: 'string' }, baseUrl: { type: 'string', format: 'uri', pattern: '^https://', description: 'Registry root or path prefix without /v0.1, query parameters, fragments, or credentials.' }, enabled: { type: 'boolean' }, networkRoute: { type: 'string', enum: ['direct'] }, auth: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['none', 'bearer_token', 'custom_header'] }, credential: { type: 'string', minLength: 1, writeOnly: true, description: 'Required for bearer or custom-header replacement; forbidden when type is none.' }, headerName: { type: 'string', description: 'Required only for custom_header.' } }, additionalProperties: false } }, additionalProperties: false } } } }, responses: { '200': { description: 'Registry updated and synchronized when its URL or authentication changed.' }, '409': { description: 'Deployment-managed registry or duplicate name conflict.' } } },
      delete: { tags: ['catalog'], summary: 'Delete a workspace MCP registry', description: 'Requires manage_catalog_sources. Installed MCP servers retain pinned provenance and are not removed. Deployment-managed registries cannot be deleted.', security: [{ userSession: [] }], parameters: [workspaceId, sourceId], responses: { '204': { description: 'Registry cache and credential removed.' }, '409': { description: 'Deployment-managed registry.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/catalog/sources/{sourceId}/sync': {
      post: { tags: ['catalog'], summary: 'Synchronize an MCP registry', description: 'Requires manage_catalog_sources. Deployment-managed and workspace-managed registries may be synchronized.', security: [{ userSession: [] }], parameters: [workspaceId, sourceId], responses: { '200': { description: 'Full synchronization completed.', content: { 'application/json': { schema: { type: 'object', required: ['artifactCount'], properties: { artifactCount: { type: 'integer', minimum: 0 } }, additionalProperties: false } } } } } }
    },
    '/api/v1/workspaces/{workspaceId}/catalog/artifacts': {
      get: { tags: ['catalog'], summary: 'Browse normalized catalog artifacts', security: [{ userSession: [] }], parameters: [workspaceId, { in: 'query', name: 'sourceId', schema: { type: 'string', format: 'uuid' } }, { in: 'query', name: 'q', schema: { type: 'string' } }, { in: 'query', name: 'compatible', schema: { type: 'boolean' } }, { in: 'query', name: 'refresh', schema: { type: 'boolean' } }], responses: { '200': { description: 'Catalog artifact page.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/catalog/artifacts/{artifactId}': {
      get: { tags: ['catalog'], summary: 'Read a normalized catalog artifact', security: [{ userSession: [] }], parameters: [workspaceId, artifactId], responses: { '200': { description: 'Catalog artifact.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/mcp/servers': {
      get: { tags: ['agents'], summary: 'List MCP servers installed on one Agent', security: [{ userSession: [] }], parameters: [workspaceId, agentId], responses: { '200': { description: 'Secret-free Agent MCP installations.' } } },
      post: { tags: ['agents'], summary: 'Manually install an MCP server on one Agent', description: 'Requires manage_agents and manage_mcp. Credentials are forbidden; bearer and custom-header installations automatically use principal-owned connections.', security: [{ userSession: [] }], parameters: [workspaceId, agentId], requestBody: manualAgentMcpBody, responses: { '201': { description: 'Agent MCP installation created.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/mcp/servers/{serverId}': {
      patch: { tags: ['agents'], summary: 'Update an Agent MCP installation', description: 'Optimistic concurrency uses expectedRevision. manage_agents alone may disable; additions and reconfiguration also require manage_mcp.', security: [{ userSession: [] }], parameters: [workspaceId, agentId, serverId], responses: { '200': { description: 'Agent MCP installation updated.' }, '409': { description: 'Revision conflict.' } } },
      delete: { tags: ['agents'], summary: 'Remove an MCP server from one Agent', description: 'Requires manage_agents.', security: [{ userSession: [] }], parameters: [workspaceId, agentId, serverId], responses: { '204': { description: 'Installation removed.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/mcp/servers/{serverId}/reimport': {
      post: { tags: ['catalog'], summary: 'Explicitly reimport a pinned catalog MCP server', description: 'Requires manage_agents and manage_mcp. The existing installation ID is retained and its immutable provenance and discovered tool review state are updated transactionally.', security: [{ userSession: [] }], parameters: [workspaceId, agentId, serverId], requestBody: importBody, responses: { '200': { description: 'Agent MCP installation reimported.' }, '409': { description: 'Revision or provenance conflict.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/mcp/servers/{serverId}/test-connection': {
      post: { tags: ['agents'], summary: 'Test and discover tools for an unauthenticated Agent MCP installation', description: 'Requires manage_agents and manage_mcp. Authenticated installations use the personal connection Verify operation.', security: [{ userSession: [] }], parameters: [workspaceId, agentId, serverId], responses: { '200': { description: 'Connection and discovery result.' }, '409': { description: 'Authenticated installations require personal connection Verify.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/mcp/servers/{serverId}/tools': {
      get: { tags: ['agents'], summary: 'List tools supplied by one Agent MCP installation', security: [{ userSession: [] }], parameters: [workspaceId, agentId, serverId], responses: { '200': { description: 'Discovered tools with review and risk state.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/mcp/servers/{serverId}/tools/{toolName}': {
      patch: { tags: ['agents'], summary: 'Review and classify an Agent MCP tool', description: 'Tool approval requires manage_mcp. Only administrator-approved non-destructive writes may be auto allowed.', security: [{ userSession: [] }], parameters: [workspaceId, agentId, serverId, toolName], responses: { '200': { description: 'Tool review updated.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/skills': {
      get: { tags: ['agents'], summary: 'List skills installed on one Agent', security: [{ userSession: [] }], parameters: [workspaceId, agentId], responses: { '200': { description: 'Agent skill installations.' } } },
      post: { tags: ['agents'], summary: 'Install a manual skill on one Agent', description: 'Requires manage_agents and manage_skills.', security: [{ userSession: [] }], parameters: [workspaceId, agentId], responses: { '201': { description: 'Skill installed.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/skills/import': {
      post: { tags: ['agents'], summary: 'Import a pinned Git skill on one Agent', description: 'Requires immutable Git commit provenance and manage_agents plus manage_skills.', security: [{ userSession: [] }], parameters: [workspaceId, agentId], responses: { '201': { description: 'Skill imported.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/skills/{skillId}': {
      get: { tags: ['agents'], summary: 'Read an Agent skill installation', security: [{ userSession: [] }], parameters: [workspaceId, agentId, skillId], responses: { '200': { description: 'Skill detail.' } } },
      patch: { tags: ['agents'], summary: 'Update or disable an Agent skill', description: 'manage_agents alone may disable; edits or enabling also require manage_skills.', security: [{ userSession: [] }], parameters: [workspaceId, agentId, skillId], responses: { '200': { description: 'Skill updated.' } } },
      delete: { tags: ['agents'], summary: 'Remove a skill from one Agent', security: [{ userSession: [] }], parameters: [workspaceId, agentId, skillId], responses: { '204': { description: 'Skill removed.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/skills/{skillId}/reimport': {
      post: { tags: ['agents'], summary: 'Explicitly reimport a pinned Git skill', security: [{ userSession: [] }], parameters: [workspaceId, agentId, skillId], responses: { '200': { description: 'Skill reimported as a new Agent capability revision.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/mcp/servers/import': {
      post: { tags: ['catalog'], summary: 'Install a pinned catalog MCP server on one Agent', description: 'Requires both manage_agents and manage_mcp. Repeating an identical import is idempotent; upgrades require explicit reimport.', security: [{ userSession: [] }], parameters: [workspaceId, agentId], requestBody: importBody, responses: { '201': { description: 'Agent MCP installation created.' }, '409': { description: 'Explicit reimport is required for a changed version, digest, or endpoint.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/import': {
      post: { tags: ['catalog'], summary: 'Install a pinned catalog MCP server on one target', description: 'Requires manage_mcp. The server resolves workspace ownership and target type; browser-supplied target type and Agent target constraints are rejected. Credentials remain principal-owned.', security: [{ userSession: [] }], parameters: [workspaceId, targetId], requestBody: importBody, responses: { '201': { description: 'Target MCP installation created.' }, '409': { description: 'Explicit reimport is required for a changed version, digest, or endpoint.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/reimport': {
      post: { tags: ['catalog'], summary: 'Explicitly reimport a pinned catalog MCP server on one target', description: 'Requires manage_mcp. The existing target installation ID is retained and expectedRevision protects against stale updates.', security: [{ userSession: [] }], parameters: targetConnection, requestBody: importBody, responses: { '200': { description: 'Target MCP installation reimported.' }, '409': { description: 'Revision or provenance conflict.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/mcp/servers/{serverId}/connection': connectionPaths(agentConnection),
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/connection': connectionPaths(targetConnection),
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/mcp/servers/{serverId}/connection/verify': verifyConnectionPath(agentConnection),
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/connection/verify': verifyConnectionPath(targetConnection)
  };
}
