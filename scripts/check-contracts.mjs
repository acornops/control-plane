import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

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

function readFilesUnder(absolutePath) {
  if (!existsSync(absolutePath)) return [];
  const stat = statSync(absolutePath);
  if (!stat.isDirectory()) {
    return [absolutePath];
  }
  return readdirSync(absolutePath)
    .sort()
    .flatMap((entry) => readFilesUnder(path.join(absolutePath, entry)));
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
const manifestText = JSON.stringify(manifest);
const canonicalJsonVectors = read('docs/contracts/canonical-json-vectors.json');
const publicHeaderVectors = read('docs/contracts/mcp-public-header-vectors.json');
const authController = read('src/controllers/auth-controller.ts');
const contracts = [
  read('src/types/contracts.ts'),
  read('src/types/webhook-contracts.ts')
].join('\n');
const runEventsContract = read('src/types/run-events-contract.ts');
const configSource = read('src/config.ts');
const mcpRegistryClient = read('src/services/mcp-registry-client.ts');
const wsServer = read('src/agent/ws-server.ts');
const agentSource = [wsServer, read('src/agent/handshake.ts')].join('\n');
const toolSync = [
  read('src/services/target-built-in-tool-sync.ts'),
  read('src/services/kubernetes-cluster-tool-sync.ts'),
  read('src/services/virtual-machine-tool-sync.ts')
].join('\n');
const internalExecutionBootstrap = read('src/controllers/internal-execution-bootstrap.ts');
const targetRunToolResolution = read('src/services/target-run-tool-resolution.ts');
const internalMcpBridgeController = read('src/controllers/internal-mcp-bridge-controller.ts');
const openApi = [read('src/docs/openapi.ts'), readTree('src/docs/openapi')].join('\n');
const generatedPublicOpenApiPath = path.resolve(root, '..', 'docs-website', 'openapi', 'control-plane-public.json');
const generatedPublicOpenApi = existsSync(generatedPublicOpenApiPath)
  ? JSON.parse(readFileSync(generatedPublicOpenApiPath, 'utf8'))
  : null;
const managementConsoleContract = manifest.counterparts?.['management-console'];
const executionEngineContract = manifest.counterparts?.['execution-engine'];
const llmGatewayContract = manifest.counterparts?.['llm-gateway'];
const agentContract = manifest.counterparts?.['agentk'];

const gatewayCanonicalVectorsPath = path.resolve(
  root,
  '..',
  'llm-gateway',
  'docs',
  'contracts',
  'canonical-json-vectors.json'
);
if (existsSync(gatewayCanonicalVectorsPath)) {
  expect(
    readFileSync(gatewayCanonicalVectorsPath, 'utf8') === canonicalJsonVectors,
    'Control-plane and LLM-gateway canonical JSON vectors must be byte-identical'
  );
}

for (const [repoName, vectorsPath] of [
  ['LLM-gateway', path.resolve(root, '..', 'llm-gateway', 'docs', 'contracts', 'mcp-public-header-vectors.json')],
  ['management console', path.resolve(root, '..', 'management-console', 'docs', 'contracts', 'mcp-public-header-vectors.json')]
]) {
  if (existsSync(vectorsPath)) {
    expect(
      readFileSync(vectorsPath, 'utf8') === publicHeaderVectors,
      `Control-plane and ${repoName} MCP public-header vectors must be byte-identical`
    );
  }
}

expectIncludes(readme, '[`docs/contracts/README.md`](docs/contracts/README.md)', 'README contract link');
expectIncludes(readme, '[`docs/contracts/manifest.json`](docs/contracts/manifest.json)', 'README manifest link');
expectIncludes(readme, 'Signup does not create or attach a workspace.', 'Password signup workspace ownership note');
expect(manifest.repo === 'control-plane', 'Manifest repo');
expect(
  JSON.stringify(agentContract?.agentTypeValues) === JSON.stringify(['agentk']),
  'AgentK contract should expose only the canonical agentType value'
);
expectIncludes(agentSource, "? 'agentv' : 'agentk'", 'AgentK canonical agentType implementation');

for (const heading of [
  '# Control Plane Contracts',
  '## Source Of Truth',
  '## Dependency Matrix',
  '## Shared Invariants',
  '## Boundary Notes',
  '## Change Checklist'
]) {
  expectIncludes(doc, heading, 'Contract doc heading');
}

function generatedPublicPaths() {
  return new Set(Object.keys(generatedPublicOpenApi?.paths || {}));
}

function templateExpressionPlaceholder(expression) {
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression.getText();
    const [firstArg] = expression.arguments;
    if (callee === 'pageQuery') {
      return '';
    }
    if (callee === 'encodeURIComponent' && firstArg && ts.isIdentifier(firstArg)) {
      return `{${firstArg.text}}`;
    }
  }
  if (ts.isIdentifier(expression)) {
    return /query$/i.test(expression.text) ? '' : `{${expression.text}}`;
  }
  if (ts.isConditionalExpression(expression)) {
    return '';
  }
  return `{${expression.getText()}}`;
}

function templateExpressionText(node) {
  let text = node.head.text;
  for (const span of node.templateSpans) {
    text += templateExpressionPlaceholder(span.expression);
    text += span.literal.text;
  }
  return text;
}

function normalizeFrontendApiPath(value) {
  const apiIndex = value.indexOf('/api/v1');
  const internalIndex = value.indexOf('/internal/v1');
  const startCandidates = [apiIndex, internalIndex].filter((index) => index >= 0);
  if (startCandidates.length === 0) return null;
  const start = Math.min(...startCandidates);
  const apiPath = value
    .slice(start)
    .replace(/\?\s*$/, '')
    .replace(/\{[^}]*query[^}]*\}$/i, '')
    .split('?')[0];
  return apiPath || null;
}

function extractFrontendApiPaths(source, filename) {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const paths = new Set();

  function visit(node) {
    let value = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      value = node.text;
    } else if (ts.isTemplateExpression(node)) {
      value = templateExpressionText(node);
    }
    const isComposedPathHelper = ts.isTemplateExpression(node)
      && ts.isArrowFunction(node.parent)
      && node.parent.body === node;
    if (value && !isComposedPathHelper) {
      const apiPath = normalizeFrontendApiPath(value);
      if (apiPath) paths.add(apiPath);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return paths;
}

function checkManagementConsoleSourceApiCoverage() {
  const managementConsoleRoot = process.env.ACORNOPS_MANAGEMENT_CONSOLE_ROOT
    ? path.resolve(process.env.ACORNOPS_MANAGEMENT_CONSOLE_ROOT)
    : path.resolve(root, '..', 'management-console');
  const servicesRoot = path.join(managementConsoleRoot, 'src', 'services');
  if (!existsSync(servicesRoot)) return;

  if (!generatedPublicOpenApi) {
    console.log('Skipping management-console/OpenAPI route inventory check because docs-website is not checked out.');
    return;
  }
  const documentedPaths = generatedPublicPaths();
  const frontendPaths = new Set();
  for (const filename of readFilesUnder(servicesRoot)) {
    if (!/\.[cm]?[tj]sx?$/.test(filename) || /\.test\.[cm]?[tj]sx?$/.test(filename)) continue;
    const source = readFileSync(filename, 'utf8');
    for (const apiPath of extractFrontendApiPaths(source, filename)) {
      frontendPaths.add(apiPath);
    }
  }

  for (const apiPath of Array.from(frontendPaths).sort()) {
    expect(
      documentedPaths.has(apiPath),
      `Management-console service API path is missing from generated public OpenAPI: ${apiPath}`
    );
  }
}

checkManagementConsoleSourceApiCoverage();

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

for (const eventType of managementConsoleContract.webhookEventTypes) {
  expectIncludes(contracts, eventType, 'Webhook event schema');
}

for (const adminPath of [
  '/api/v1/internal/mcp/servers',
  '/api/v1/internal/mcp/tools',
  '/api/v1/internal/mcp/tools/${encodeURIComponent(toolName)}',
  '/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}',
  '/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}/test'
]) {
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
  'config.BUILTIN_TARGET_MCP_SERVER_URL'
]) {
  expectIncludes(toolSync, builtinConfigNeedle, 'Builtin MCP bridge implementation');
}

expectIncludes(internalMcpBridgeController, 'res.locals.gatewayRunClaims', 'Builtin MCP run token claims');
expectIncludes(internalMcpBridgeController, 'isToolAllowedByRunToken(toolName, claims.allowedTools)', 'Builtin MCP allowed-tool check');
expectIncludes(internalMcpBridgeController, 'operationForToolCall(claims, toolName)', 'Builtin MCP audit operation classification');
expectIncludes(internalMcpBridgeController, 'stableAgentRequestId(claims.runId, req.body.toolCallId)', 'Stable AgentK operation id forwarding');
expectIncludes(contracts, 'toolCallId: z.string().min(1).max(256).optional()', 'Builtin MCP tool call id contract');
expectIncludes(doc, '`operation` is `read` or `write`', 'Workspace audit operation doc');
expectIncludes(openApi, 'operation=read|write', 'Workspace audit operation OpenAPI doc');
expectIncludes(configSource, 'WORKSPACE_AUDIT_LOGGING_MODE', 'Workspace audit logging mode config');
expectIncludes(configSource, 'WORKSPACE_AUDIT_RETENTION_DAYS', 'Workspace audit retention config');
expectIncludes(configSource, 'TARGET_METRIC_HISTORY_RETENTION_DAYS', 'Target metric history retention config');

for (const contractToken of [
  'Roles with `permissions.manage_mcp` may mutate MCP server configuration.',
  'Roles with `permissions.manage_tools` may mutate MCP per-tool enablement and non-Target-Insights built-in tool settings.',
  'Roles with `permissions.manage_target_insights` may mutate Target Insights entries and Target Insights tool settings.',
  'Roles without the relevant management capability are read-only for that configuration surface.',
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
  expectIncludes(manifestText, eventType, 'Execution-engine event manifest');
}
for (const field of [
  ...executionEngineContract.toolCallCompletedPayloadFields,
  ...executionEngineContract.toolCallCompletedContextMetaFields,
  ...executionEngineContract.toolCallCompletedArtifactFields
]) {
  expectIncludes(runEventsContract, field.replace(/\?$/, ''), 'Tool completion event field');
}
expect(executionEngineContract.toolCallCompletedResultMaxBytes === 12 * 1024, 'Tool completion event byte limit');
expectIncludes(runEventsContract, 'MAX_MODEL_CONTEXT_BYTES = 12 * 1024', 'Tool completion event byte limit implementation');

expectIncludes(doc, executionEngineContract.dispatchAuth, 'Execution-engine dispatch auth doc');
expectIncludes(configSource, 'EXECUTION_ENGINE_DISPATCH_TOKEN', 'Execution-engine dispatch token config');
expectIncludes(
  read('src/services/execution-engine-client.ts'),
  'authorization: `Bearer ${config.EXECUTION_ENGINE_DISPATCH_TOKEN}`',
  'Execution-engine dispatch client auth'
);

for (const toolName of agentContract.builtinToolNames) {
  expectIncludes(manifestText, toolName, 'AgentK builtin tool manifest');
}
for (const dynamicCatalogNeedle of [
  'advertisedTools',
  'const allowedTools = [...new Set(advertisedTools.map((tool) => tool.name))]',
  'agentGateway.listAgentTools(targetId)'
]) {
  expectIncludes(
    `${agentSource}\n${toolSync}`,
    dynamicCatalogNeedle,
    'Target-advertised built-in tool implementation'
  );
}

for (const guardNeedle of [
  "capability === 'write' && !targetSupportsWrite",
  "capability === 'write' && !runAllowsWrite"
]) {
  expectIncludes(targetRunToolResolution, guardNeedle, 'Write-tool gate implementation');
}

if (failures.length > 0) {
  console.error('Contract checks failed:\n');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Contract checks passed.');
