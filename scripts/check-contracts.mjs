import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function readTree(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const stat = statSync(absolutePath);
  if (!stat.isDirectory()) {
    return read(relativePath);
  }

  return readdirSync(absolutePath)
    .sort()
    .map((entry) => readTree(path.join(relativePath, entry)))
    .join('\n');
}

const failures = [];

function expect(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function expectIncludes(content, needle, message) {
  expect(content.includes(needle), `${message}: missing ${needle}`);
}

const readme = read('README.md');
const doc = read('docs/contracts/README.md');
const manifest = JSON.parse(read('docs/contracts/manifest.json'));
const authRoutes = read('src/routes/auth.ts');
const authController = read('src/controllers/auth-controller.ts');
const workspaceRouteSources = [read('src/routes/workspaces.ts'), readTree('src/routes/workspaces')].join('\n');
const expandedWorkspaceRoutes = workspaceRouteSources
  .replaceAll('router.', 'workspacesRouter.')
  .replace(/\n\s+'/g, "\n  '");
const compactWorkspaceRoutes = expandedWorkspaceRoutes
  .replaceAll("workspacesRouter.get(\n  '", "workspacesRouter.get('")
  .replaceAll("workspacesRouter.post(\n  '", "workspacesRouter.post('")
  .replaceAll("workspacesRouter.patch(\n  '", "workspacesRouter.patch('")
  .replaceAll("workspacesRouter.delete(\n  '", "workspacesRouter.delete('");
const workspaceRoutes = `${workspaceRouteSources}\n${expandedWorkspaceRoutes}\n${compactWorkspaceRoutes}`;
const webhookRoutes = read('src/routes/webhooks.ts');
const sessionRoutes = read('src/routes/sessions.ts');
const runRoutes = read('src/routes/runs.ts');
const internalRoutes = read('src/routes/internal-execution.ts');
const contracts = read('src/types/contracts.ts');
const configSource = read('src/config.ts');
const mcpRegistryClient = read('src/services/mcp-registry-client.ts');
const wsServer = read('src/agent/ws-server.ts');
const agentSource = [wsServer, read('src/agent/handshake.ts')].join('\n');
const toolSync = [
  read('src/services/target-built-in-tool-sync.ts'),
  read('src/services/kubernetes-cluster-tool-sync.ts'),
  read('src/services/virtual-machine-tool-sync.ts')
].join('\n');
const internalController = read('src/controllers/internal-execution-controller.ts');
const internalMcpBridgeController = read('src/controllers/internal-mcp-bridge-controller.ts');
const openApi = [read('src/docs/openapi.ts'), readTree('src/docs/openapi')].join('\n');
const managementConsoleContract = manifest.counterparts?.['management-console'];
const externalIntegrationClientContract = manifest.counterparts?.['external-integration-client'];
const executionEngineContract = manifest.counterparts?.['execution-engine'];
const llmGatewayContract = manifest.counterparts?.['llm-gateway'];
const agentContract = manifest.counterparts?.['k8s-agent'];

expectIncludes(readme, '[`docs/contracts/README.md`](docs/contracts/README.md)', 'README contract link');
expectIncludes(readme, '[`docs/contracts/manifest.json`](docs/contracts/manifest.json)', 'README manifest link');
expectIncludes(readme, 'Signup does not create or attach a workspace.', 'Password signup workspace ownership note');
expect(manifest.repo === 'control-plane', 'Manifest repo');

for (const heading of [
  '# Control Plane Contracts',
  '## Dependency Matrix',
  '## Shared Invariants',
  '## Management Console Public Contract',
  '## Execution-Engine Contract',
  '## LLM-Gateway Contract',
  '## K8s-Agent Contract'
]) {
  expectIncludes(doc, heading, 'Contract doc heading');
}

function openApiPath(contractPath) {
  return contractPath
    .replace(/^[A-Z]+ /, '')
    .replace(/\?run_id=<runId>$/, '')
    .replace(/\?return_to=<management-console-url>$/, '')
    .replace(/\?token=<external-integration-link-token>$/, '');
}

for (const [docPath, routeNeedle, source, label] of [
  ['`GET /api/v1/auth/oidc/login?return_to=<management-console-url>`', "authRouter.get('/auth/oidc/login'", authRoutes, 'OIDC login route'],
  ['`GET /api/v1/auth/oidc/callback`', "authRouter.get('/auth/oidc/callback'", authRoutes, 'OIDC callback route'],
  ['`GET /api/v1/auth/csrf`', "authRouter.get('/auth/csrf'", authRoutes, 'CSRF token route'],
  ['`POST /api/v1/auth/password/login`', "authRouter.post('/auth/password/login'", authRoutes, 'Password login route'],
  ['`POST /api/v1/auth/password/signup`', "authRouter.post('/auth/password/signup'", authRoutes, 'Password signup route'],
  ['`POST /api/v1/auth/logout`', "authRouter.post('/auth/logout'", authRoutes, 'Logout route'],
  ['`POST /api/v1/auth/external-integrations/link`', "authRouter.post('/auth/external-integrations/link'", authRoutes, 'ExternalIntegration link create route'],
  ['`POST /api/v1/auth/external-integrations/resolve`', "authRouter.post('/auth/external-integrations/resolve'", authRoutes, 'ExternalIntegration link resolve route'],
  ['`POST /api/v1/auth/external-integrations/link/preview`', "authRouter.post('/auth/external-integrations/link/preview'", authRoutes, 'ExternalIntegration browser link preview route'],
  ['`POST /api/v1/auth/external-integrations/link/complete`', "authRouter.post('/auth/external-integrations/link/complete'", authRoutes, 'ExternalIntegration browser link completion route'],
  ['`GET /api/v1/me`', "authRouter.get('/me'", authRoutes, 'Current-user route'],
  ['`POST /api/v1/auth/dev-login`', "authRouter.post('/auth/dev-login'", authRoutes, 'Dev-login route'],
  ['`GET /api/v1/workspaces`', "workspacesRouter.get('/workspaces'", workspaceRoutes, 'List workspaces route'],
  ['`POST /api/v1/workspaces`', "workspacesRouter.post('/workspaces'", workspaceRoutes, 'Create workspace route'],
  ['`GET /api/v1/workspaces/{workspaceId}`', "workspacesRouter.get('/workspaces/:workspaceId'", workspaceRoutes, 'Get workspace route'],
  ['`DELETE /api/v1/workspaces/{workspaceId}`', "workspacesRouter.delete('/workspaces/:workspaceId'", workspaceRoutes, 'Delete workspace route'],
  ['`GET /api/v1/workspaces/{workspaceId}/members`', "workspacesRouter.get('/workspaces/:workspaceId/members'", workspaceRoutes, 'List workspace members route'],
  ['`GET /api/v1/workspaces/{workspaceId}/audit-log`', "workspacesRouter.get('/workspaces/:workspaceId/audit-log'", workspaceRoutes, 'List workspace audit log route'],
  ['`GET /api/v1/workspaces/{workspaceId}/invitations`', "workspacesRouter.get(\n  '/workspaces/:workspaceId/invitations'", workspaceRoutes, 'List workspace invitation route'],
  ['`POST /api/v1/workspaces/{workspaceId}/invitations`', "workspacesRouter.post(\n  '/workspaces/:workspaceId/invitations'", workspaceRoutes, 'Create workspace invitation route'],
  ['`DELETE /api/v1/workspaces/{workspaceId}/invitations/{invitationId}`', "workspacesRouter.delete(\n  '/workspaces/:workspaceId/invitations/:invitationId'", workspaceRoutes, 'Revoke workspace invitation route'],
  ['`GET /api/v1/workspace-invitations/{token}`', "workspacesRouter.get('/workspace-invitations/:token'", workspaceRoutes, 'Get workspace invitation route'],
  ['`POST /api/v1/workspace-invitations/{token}/accept`', "workspacesRouter.post(\n  '/workspace-invitations/:token/accept'", workspaceRoutes, 'Accept workspace invitation route'],
  ['`POST /api/v1/workspaces/{workspaceId}/members`', "workspacesRouter.post(\n  '/workspaces/:workspaceId/members'", workspaceRoutes, 'Add workspace member route'],
  ['`PATCH /api/v1/workspaces/{workspaceId}/members/{userId}`', "workspacesRouter.patch(\n  '/workspaces/:workspaceId/members/:userId'", workspaceRoutes, 'Update workspace member route'],
  ['`DELETE /api/v1/workspaces/{workspaceId}/members/{userId}`', "workspacesRouter.delete(\n  '/workspaces/:workspaceId/members/:userId'", workspaceRoutes, 'Delete workspace member route'],
  ['`GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters`', "workspacesRouter.get('/workspaces/:workspaceId/kubernetes-clusters'", workspaceRoutes, 'List clusters route'],
  ['`GET /api/v1/workspaces/{workspaceId}/investigations`', "workspacesRouter.get('/workspaces/:workspaceId/investigations'", workspaceRoutes, 'List investigations route'],
  ['`GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}`', "workspacesRouter.get('/workspaces/:workspaceId/kubernetes-clusters/:clusterId'", workspaceRoutes, 'Get cluster route'],
  ['`GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/resources`', "'/workspaces/:workspaceId/kubernetes-clusters/:clusterId/resources'", workspaceRoutes, 'List cluster resources route'],
  ['`GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/findings`', "'/workspaces/:workspaceId/kubernetes-clusters/:clusterId/findings'", workspaceRoutes, 'List cluster findings route'],
  [
    '`POST /api/v1/workspaces/{workspaceId}/kubernetes-clusters`',
    "workspacesRouter.post(\n  '/workspaces/:workspaceId/kubernetes-clusters'",
    workspaceRoutes,
    'Register cluster route'
  ],
  ['`PATCH /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}`', "workspacesRouter.patch(\n  '/workspaces/:workspaceId/kubernetes-clusters/:clusterId'", workspaceRoutes, 'Patch cluster route'],
  ['`DELETE /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}`', "workspacesRouter.delete('/workspaces/:workspaceId/kubernetes-clusters/:clusterId'", workspaceRoutes, 'Delete cluster route'],
  ['`POST /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/rotate-agent-key`', "'/workspaces/:workspaceId/kubernetes-clusters/:clusterId/rotate-agent-key'", workspaceRoutes, 'Rotate agent-key route'],
  ['`GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/pods/{namespace}/{podName}/logs`', "'/workspaces/:workspaceId/kubernetes-clusters/:clusterId/pods/:namespace/:podName/logs'", workspaceRoutes, 'Pod logs route'],
  ['`GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/tools/catalog`', "'/workspaces/:workspaceId/kubernetes-clusters/:clusterId/tools/catalog'", workspaceRoutes, 'Tools catalog route'],
  ['`PATCH /api/v1/workspaces/{workspaceId}/targets/{targetId}/tools/{toolName}`', "'/workspaces/:workspaceId/targets/:targetId/tools/:toolName'", workspaceRoutes, 'Target tool patch route'],
  ['`GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers`', "workspacesRouter.get('/workspaces/:workspaceId/targets/:targetId/mcp/servers'", workspaceRoutes, 'List target MCP servers route'],
  ['`GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/tools`', "'/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/tools'", workspaceRoutes, 'List target MCP server tools route'],
  ['`POST /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers`', "'/workspaces/:workspaceId/targets/:targetId/mcp/servers'", workspaceRoutes, 'Create target MCP server route'],
  ['`PATCH /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}`', "'/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId'", workspaceRoutes, 'Patch target MCP server route'],
  ['`DELETE /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}`', "'/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId'", workspaceRoutes, 'Delete target MCP server route'],
  ['`POST /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/test-connection`', "'/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/test-connection'", workspaceRoutes, 'Test target MCP server route'],
  ['`POST /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/sessions`', "'/workspaces/:workspaceId/kubernetes-clusters/:clusterId/sessions'", sessionRoutes, 'Create session route'],
  ['`GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/sessions`', "'/workspaces/:workspaceId/kubernetes-clusters/:clusterId/sessions'", sessionRoutes, 'List sessions route'],
  ['`DELETE /api/v1/sessions/{sessionId}`', "sessionsRouter.delete('/sessions/:sessionId'", sessionRoutes, 'Delete session route'],
  ['`GET /api/v1/sessions/{sessionId}/messages`', "sessionsRouter.get('/sessions/:sessionId/messages'", sessionRoutes, 'List messages route'],
  ['`POST /api/v1/sessions/{sessionId}/messages`', "sessionsRouter.post('/sessions/:sessionId/messages'", sessionRoutes, 'Post message route'],
  ['`GET /api/v1/runs/{runId}`', "runsRouter.get('/runs/:runId'", runRoutes, 'Get run route'],
  ['`GET /api/v1/runs/{runId}/events`', "runsRouter.get('/runs/:runId/events'", runRoutes, 'Run events route'],
  ['`GET /api/v1/runs/{runId}/stream`', "runsRouter.get('/runs/:runId/stream'", runRoutes, 'Run stream route'],
  ['`GET /api/v1/runs/{runId}/approvals`', "runsRouter.get('/runs/:runId/approvals'", runRoutes, 'Run approvals route'],
  ['`POST /api/v1/runs/{runId}/approvals/{approvalId}/decision`', "'/runs/:runId/approvals/:approvalId/decision'", runRoutes, 'Run approval decision route'],
  ['`POST /api/v1/runs/{runId}/cancel`', "runsRouter.post('/runs/:runId/cancel'", runRoutes, 'Run cancel route'],
  ['`POST /internal/v1/runs/{runId}/bootstrap`', "internalExecutionRouter.post('/runs/:runId/bootstrap'", internalRoutes, 'Bootstrap route'],
  ['`POST /internal/v1/runs/{runId}/approvals`', "internalExecutionRouter.post(\n  '/runs/:runId/approvals'", internalRoutes, 'Internal create approval route'],
  ['`GET /internal/v1/runs/{runId}/continuation`', "internalExecutionRouter.get(\n  '/runs/:runId/continuation'", internalRoutes, 'Internal continuation route'],
  ['`POST /internal/v1/runs/{runId}/approvals/{approvalId}/execution-started`', "'/runs/:runId/approvals/:approvalId/execution-started'", internalRoutes, 'Internal approval execution started route'],
  ['`POST /internal/v1/runs/{runId}/approvals/{approvalId}/execution-finished`', "'/runs/:runId/approvals/:approvalId/execution-finished'", internalRoutes, 'Internal approval execution finished route'],
  ['`DELETE /internal/v1/runs/{runId}/continuation`', "internalExecutionRouter.delete(\n  '/runs/:runId/continuation'", internalRoutes, 'Internal consume continuation route'],
  ['`GET /internal/v1/sessions/{sessionId}/context?run_id=<runId>`', "internalExecutionRouter.get('/sessions/:sessionId/context'", internalRoutes, 'Context route'],
  ['`POST /internal/v1/runs/{runId}/events`', "internalExecutionRouter.post(\n  '/runs/:runId/events'", internalRoutes, 'Run ingest route'],
  ['`POST /internal/v1/runs/{runId}/commit`', "internalExecutionRouter.post(\n  '/runs/:runId/commit'", internalRoutes, 'Run commit route'],
  ['`POST /internal/v1/mcp/tools/call`', "internalExecutionRouter.post(\n  '/mcp/tools/call'", internalRoutes, 'Builtin MCP call route'],
  ['`GET /api/v1/workspaces/{workspaceId}/webhooks`', "webhooksRouter.get('/workspaces/:workspaceId/webhooks'", webhookRoutes, 'List webhooks route'],
  ['`POST /api/v1/workspaces/{workspaceId}/webhooks`', "webhooksRouter.post(\n  '/workspaces/:workspaceId/webhooks'", webhookRoutes, 'Create webhook route'],
  ['`GET /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}`', "webhooksRouter.get('/workspaces/:workspaceId/webhooks/:webhookId'", webhookRoutes, 'Get webhook route'],
  ['`PATCH /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}`', "webhooksRouter.patch(\n  '/workspaces/:workspaceId/webhooks/:webhookId'", webhookRoutes, 'Patch webhook route'],
  ['`DELETE /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}`', "webhooksRouter.delete('/workspaces/:workspaceId/webhooks/:webhookId'", webhookRoutes, 'Delete webhook route'],
  ['`GET /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}/history`', "'/workspaces/:workspaceId/webhooks/:webhookId/history'", webhookRoutes, 'Webhook history route']
]) {
  expectIncludes(doc, docPath, `${label} doc`);
  expectIncludes(source, routeNeedle, `${label} implementation`);
}

for (const [needle, label] of [
  ['`objectType`', 'Workspace audit object-type filter doc'],
  ['`object`', 'Workspace audit object field doc']
]) {
  expectIncludes(doc, needle, label);
}

const workspaceAuditSources = [
  read('src/controllers/workspaces/audit-controller.ts'),
  read('src/store/repository-audit-events.ts')
].join('\n');

for (const [needle, label] of [
  ['const objectType = parseAuditStringFilter', 'Workspace audit object-type controller filter'],
  ['object: event.object', 'Workspace audit object serialization'],
  ['object_type, object_id, object_name', 'Workspace audit object persistence columns']
]) {
  expectIncludes(workspaceAuditSources, needle, label);
}

expectIncludes(openApi, "name: 'objectType'", 'Workspace audit OpenAPI object-type query');
expectIncludes(openApi, 'object: jsonObject', 'Workspace audit OpenAPI object field');
expectIncludes(openApi, 'occurredAt: dateTime', 'Workspace audit OpenAPI occurredAt field');
expectIncludes(openApi, 'workspaceAuditSearchParameters', 'Admin workspace audit OpenAPI query parameter docs');

for (const [functionName, label] of [
  ['oidcCallback', 'OIDC callback'],
  ['passwordLogin', 'Password login'],
  ['passwordSignup', 'Password signup']
]) {
  const start = authController.indexOf(`export async function ${functionName}`);
  const next = authController.indexOf('\nexport async function ', start + 1);
  const body = authController.slice(start, next === -1 ? authController.length : next);
  expect(
    !body.includes('ensureDevelopmentAccessForUser'),
    `${label} must not auto-grant development workspace membership`
  );
}

for (const contractPath of [
  ...managementConsoleContract.authPaths,
  ...managementConsoleContract.workspaceTargetKubernetesClusterPaths,
  ...managementConsoleContract.toolingPaths,
  ...managementConsoleContract.chatRunPaths,
  ...managementConsoleContract.webhookPaths,
  ...externalIntegrationClientContract.authPaths,
  ...executionEngineContract.controlPlanePaths,
  llmGatewayContract.jwksPath,
  llmGatewayContract.builtinBridge.callPath
]) {
  expectIncludes(openApi, `'${openApiPath(contractPath)}'`, 'OpenAPI path');
}

for (const eventType of managementConsoleContract.webhookEventTypes) {
  expectIncludes(doc, eventType, 'Webhook event doc');
  expectIncludes(contracts, eventType, 'Webhook event schema');
}

for (const adminPath of [
  '/api/v1/internal/mcp/servers',
  '/api/v1/internal/mcp/tools',
  '/api/v1/internal/mcp/tools/${encodeURIComponent(toolName)}',
  '/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}',
  '/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}/test'
]) {
  expectIncludes(doc, adminPath.replaceAll('${encodeURIComponent(toolName)}', '{tool_name}').replaceAll('${encodeURIComponent(serverId)}', '{server_id}'), 'LLM-gateway admin path doc');
  expectIncludes(mcpRegistryClient, adminPath, 'LLM-gateway admin client path');
}

for (const schemaNeedle of [
  'run_id: uuidV4Schema',
  'workspace_id: uuidV4Schema',
  'target_id: uuidV4Schema',
  'target_type: z.enum(TARGET_TYPES)',
  'session_id: uuidV4Schema',
  'message_id: uuidV4Schema',
  "status: z.enum(['completed', 'failed', 'cancelled'])",
  "toolAccessMode: z.enum(['read_only', 'read_write']).optional()"
]) {
  expectIncludes(contracts, schemaNeedle, 'Schema definition');
}

for (const wsNeedle of [
  "/agent/v1/connect",
  "/api/v1/agent/connect",
  "message.method === 'lifecycle/handshake'",
  "message.method === 'lifecycle/heartbeat'",
  "message.method === 'notify/snapshot'",
  "sendJsonRpc(clusterId, 'tools/call'",
  "sendJsonRpc(clusterId, 'tools/list'",
  'supportedCapabilities'
]) {
  expectIncludes(agentSource, wsNeedle, 'Agent WebSocket implementation');
}

for (const builtinNeedle of [
  llmGatewayContract.builtinBridge.serverName,
  llmGatewayContract.builtinBridge.serverUrl,
  llmGatewayContract.builtinBridge.authHeader,
  llmGatewayContract.builtinBridge.scopeSource
]) {
  expectIncludes(doc, builtinNeedle, 'Builtin MCP bridge doc');
  if (
    builtinNeedle !== llmGatewayContract.builtinBridge.authHeader &&
    builtinNeedle !== llmGatewayContract.builtinBridge.scopeSource
  ) {
    expectIncludes(configSource, builtinNeedle, 'Builtin MCP bridge default config');
  }
}

for (const builtinConfigNeedle of [
  'config.BUILTIN_MCP_SERVER_NAME',
  'config.BUILTIN_MCP_SERVER_URL'
]) {
  expectIncludes(toolSync, builtinConfigNeedle, 'Builtin MCP bridge implementation');
}

expectIncludes(internalMcpBridgeController, 'res.locals.gatewayRunClaims', 'Builtin MCP run token claims');
expectIncludes(internalMcpBridgeController, 'isToolAllowedByRunToken(toolName, claims.allowedTools)', 'Builtin MCP allowed-tool check');
expectIncludes(internalMcpBridgeController, 'operationForToolCall(claims, toolName)', 'Builtin MCP audit operation classification');
expectIncludes(doc, '`operation` is `read` or `write`', 'Workspace audit operation doc');
expectIncludes(openApi, 'operation=read|write', 'Workspace audit operation OpenAPI doc');
expectIncludes(configSource, 'WORKSPACE_AUDIT_LOGGING_MODE', 'Workspace audit logging mode config');
expectIncludes(configSource, 'WORKSPACE_AUDIT_RETENTION_DAYS', 'Workspace audit retention config');

for (const contractToken of [
  'Roles with both `permissions.manage_tools` and `permissions.manage_mcp` may mutate tool settings and MCP server configuration.',
  'Roles without both management capabilities are read-only for tool and MCP configuration.',
  '{ items, nextCursor? }',
  'sessionPolicy.allowedTools',
  'sessionPolicy.writeEnabled',
  'config.snapshotInterval',
  'config.maxSnapshotBytes',
  'config.namespaceScope.{include,exclude}',
  'config/update_namespace_scope'
]) {
  expectIncludes(doc, contractToken, 'Contract doc invariant');
}

for (const eventType of executionEngineContract.eventTypes) {
  expectIncludes(doc, eventType, 'Execution-engine event doc');
}

expectIncludes(doc, executionEngineContract.dispatchAuth, 'Execution-engine dispatch auth doc');
expectIncludes(configSource, 'EXECUTION_ENGINE_DISPATCH_TOKEN', 'Execution-engine dispatch token config');
expectIncludes(
  read('src/services/execution-engine-client.ts'),
  'authorization: `Bearer ${config.EXECUTION_ENGINE_DISPATCH_TOKEN}`',
  'Execution-engine dispatch client auth'
);

for (const toolName of agentContract.builtinToolNames) {
  expectIncludes(doc, toolName, 'K8s-agent builtin tool doc');
  expectIncludes(agentSource, toolName, 'K8s-agent builtin tool implementation');
}

for (const guardNeedle of [
  "capability === 'write' && !targetSupportsWrite",
  "capability === 'write' && !runAllowsWrite"
]) {
  expectIncludes(internalController, guardNeedle, 'Write-tool gate implementation');
}

if (failures.length > 0) {
  console.error('Contract checks failed:\n');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Contract checks passed.');
