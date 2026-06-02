import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function listFiles(relativeDir) {
  const absoluteDir = resolve(root, relativeDir);
  const files = [];
  for (const entry of readdirSync(absoluteDir)) {
    const relativePath = join(relativeDir, entry);
    const absolutePath = resolve(root, relativePath);
    if (statSync(absolutePath).isDirectory()) {
      files.push(...listFiles(relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  let quote = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inLineComment) {
      if (current === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === '\\') {
        index += 1;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (current === '\'' || current === '"' || current === '`') {
      quote = current;
      continue;
    }
    if (current === '(') {
      depth += 1;
    } else if (current === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevelArgs(source) {
  const args = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    if (quote) {
      if (current === '\\') {
        index += 1;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === '\'' || current === '"' || current === '`') {
      quote = current;
      continue;
    }
    if (current === '(' || current === '[' || current === '{') {
      depth += 1;
    } else if (current === ')' || current === ']' || current === '}') {
      depth -= 1;
    } else if (current === ',' && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(source.slice(start).trim());
  return args;
}

function routeCalls(source) {
  const calls = [];
  const routeMethod = /\b[A-Za-z0-9_]*Router\.(?:get|post|patch|delete|put)\s*\(/g;
  for (const match of source.matchAll(routeMethod)) {
    const openIndex = source.indexOf('(', match.index);
    const closeIndex = findMatchingParen(source, openIndex);
    assert(closeIndex !== -1, `could not parse route call near ${match[0]}`);
    calls.push(source.slice(openIndex + 1, closeIndex));
  }
  return calls;
}

const authorization = read('src/auth/authorization.ts');
const workspaceAuthorization = read('src/auth/workspace-authorization.ts');
const authMiddleware = read('src/auth/middleware.ts');
const workspaceRoutes = read('src/routes/workspaces.ts');
const workspaceControllerPath = 'src/controllers/workspaces-controller.ts';
const clusterControllerPath = 'src/controllers/workspaces/kubernetes-cluster-controller.ts';
const membersControllerPath = 'src/controllers/workspaces/members-controller.ts';
const mcpControllerPath = 'src/controllers/workspaces/kubernetes-cluster-mcp-controller.ts';
const sessionControllerPath = 'src/controllers/sessions-controller.ts';
const runControllerPath = 'src/controllers/runs-controller.ts';
const webhooksControllerPath = 'src/controllers/webhooks-controller.ts';
const workspaceController = read(workspaceControllerPath);
const clusterController = read(clusterControllerPath);
const mcpController = read(mcpControllerPath);
const sessionController = read('src/controllers/sessions-controller.ts');
const runController = read('src/controllers/runs-controller.ts');
const webhooksController = read(webhooksControllerPath);
const workspaceScopedControllerPaths = [
  workspaceControllerPath,
  clusterControllerPath,
  membersControllerPath,
  mcpControllerPath,
  sessionControllerPath,
  runControllerPath,
  webhooksControllerPath
];
const workspaceScopedControllers = workspaceScopedControllerPaths.map(read).join('\n');
const allControllers = [
  workspaceScopedControllers,
  read('src/controllers/workspaces/common.ts'),
  read('src/controllers/auth-controller.ts')
].join('\n');
const repository = [
  read('src/store/repository.ts'),
  read('src/store/repository-mappers.ts'),
  read('src/store/repository-users.ts'),
  read('src/store/repository-workspaces.ts')
].join('\n');
const openApi = [
  read('src/docs/openapi.ts'),
  read('src/docs/openapi/cluster-paths.ts'),
  read('src/docs/openapi/session-run-paths.ts'),
  read('src/docs/openapi/workspace-paths.ts')
].join('\n');
const matrixDoc = read('docs/authorization-matrix.md');

assert(authMiddleware.includes('export interface AuthContext'), 'auth middleware must expose AuthContext');
assert(authMiddleware.includes('auth: AuthContext'), 'AuthenticatedRequest must require auth context');
assert(!listFiles('src').filter((file) => file.endsWith('.ts')).some((file) => read(file).includes('authUserId')), 'authUserId must not remain in src');

const directAuthzForbidden = [
  'repo.userHasWorkspaceAccess',
  'repo.getWorkspaceRole',
  'hasWorkspaceCapability'
];
const directAuthzAllowed = new Set([
  'src/auth/authorization.ts',
  'src/auth/workspace-authorization.ts'
]);
for (const file of listFiles('src').filter((candidate) => candidate.endsWith('.ts'))) {
  if (directAuthzAllowed.has(file) || file.startsWith('src/store/repository')) {
    continue;
  }
  const source = read(file);
  for (const needle of directAuthzForbidden) {
    assert(!source.includes(needle), `${file} must use centralized workspace authorization instead of ${needle}`);
  }
}

for (const controllerPath of workspaceScopedControllerPaths) {
  assert(read(controllerPath).includes('auth/workspace-authorization.js'), `${controllerPath} must import workspace authorization helpers`);
}

for (const removedHelper of [
  'requireWorkspaceAccess',
  'requireWebhookMutationPermission',
  'requireClusterToolEditPermission',
  'requireWorkspaceOwnerPermission',
  'requireWorkspaceMemberManagePermission'
]) {
  assert(!allControllers.includes(removedHelper), `stale controller authorization helper remains: ${removedHelper}`);
}

for (const helperName of [
  'getWorkspaceAuthorization',
  'requireWorkspaceRead',
  'requireWorkspaceCapability',
  'requireClusterAccess',
  'getEffectiveWorkspacePermissions'
]) {
  assert(workspaceAuthorization.includes(`function ${helperName}`), `workspace authorization helper missing ${helperName}`);
}

for (const capability of [
  'read_workspace_data',
  'read_members',
  'read_audit_log',
  'delete_workspace',
  'manage_members',
  'manage_targets',
  'manage_mcp',
  'manage_tools',
  'manage_agent_keys',
  'manage_webhooks',
  'create_sessions',
  'create_read_only_runs',
  'create_read_write_runs',
  'read_target_logs',
  'cancel_runs',
  'delete_sessions'
]) {
  assert(authorization.includes(`'${capability}'`), `authorization type missing ${capability}`);
  assert(matrixDoc.includes(capability) || matrixDoc.includes(capability.replaceAll('_', ' ')), `matrix doc missing ${capability}`);
}

for (const role of ['owner', 'admin', 'operator', 'viewer', 'auditor']) {
  assert(authorization.includes(`${role}:`), `authorization matrix missing ${role}`);
  assert(matrixDoc.toLowerCase().includes(role), `authorization doc missing ${role}`);
}

for (const adminCapability of ['manage_targets', 'manage_mcp', 'manage_tools', 'manage_agent_keys', 'manage_webhooks']) {
  assert(authorization.includes(`${adminCapability}: true`), `owner/admin capability missing ${adminCapability}`);
  assert(workspaceScopedControllers.includes(adminCapability), `workspace controller missing ${adminCapability} guard`);
}

assert(authorization.includes('delete_workspace: false'), 'admin/viewer/operator delete-workspace denial missing');
assert(authorization.includes('create_read_write_runs: false'), 'operator/viewer read-write run denial missing');
assert(authorization.includes('const OPERATOR_PERMISSIONS'), 'operator permission profile missing');
assert(authorization.includes('create_read_only_runs: true'), 'operator read-only run permission missing');
assert(authorization.includes('read_target_logs: true'), 'operator target-log read permission missing');

assert(!workspaceRoutes.includes('agent/tools/call'), 'public direct agent tool-call route must stay removed');
assert(!openApi.includes('agent/tools/call'), 'direct agent tool-call route must not appear in OpenAPI');
assert(!workspaceController.includes('direct_agent_tool'), 'direct agent tool-call audit source should not be reachable');

assert(sessionController.includes('create_sessions'), 'session creation must be capability-gated');
assert(sessionController.includes('create_read_write_runs'), 'read-write run requests must be capability-gated');
assert(sessionController.includes("toolAccessMode === 'read_write'"), 'postMessage must branch on read-write tool access');
const getSessionStart = sessionController.indexOf('export async function getSession');
const listMessagesStart = sessionController.indexOf('export async function listMessages');
const deleteSessionStart = sessionController.indexOf('export async function deleteSession');
const postMessageStart = sessionController.indexOf('export async function postMessage');
const deleteSessionGuard = sessionController.indexOf("'delete_sessions'");
assert(deleteSessionGuard > deleteSessionStart && deleteSessionGuard < postMessageStart, 'delete-session capability guard must be inside deleteSession');
assert(
  !(deleteSessionGuard > getSessionStart && deleteSessionGuard < listMessagesStart),
  'getSession must remain readable for viewer/operator roles'
);
assert(runController.includes('cancel_runs'), 'run cancellation must be capability-gated');
assert(runController.includes('create_read_write_runs'), 'approval decisions must be read-write capability-gated');
assert(clusterController.includes("'read_target_logs'"), 'pod log endpoint must be read_target_logs capability-gated');
assert(webhooksController.includes("'manage_webhooks'"), 'webhook mutations must be manage_webhooks capability-gated');
assert(!webhooksController.includes('canManageWebhooks'), 'webhook mutations must not use local role-specific authorization helpers');
assert(mcpController.includes("canEdit: access.authz.can('manage_tools') && access.authz.can('manage_mcp')"), 'tool catalog editability must use effective authz');
assert(!read('src/services/kubernetes-cluster-tools-catalog.ts').includes('role: string | null'), 'tool catalog composer must not recompute editability from role');
assert(workspaceController.includes('withEffectiveWorkspacePermissions'), 'workspace responses must serialize effective permissions');
assert(
  workspaceController.includes('applyWorkspaceSummaryPermissions(workspace, getEffectiveWorkspacePermissions(req, workspace.currentUserRole))'),
  'workspace summaries must use effective permissions'
);
assert(
  workspaceController.includes('clusterCount: canReadWorkspaceData ? workspace.clusterCount : 0') &&
    workspaceController.includes('memberCount: canReadMembers ? workspace.memberCount : 0') &&
    workspaceController.includes('members: canReadMembers ? workspace.quota.members.used : 0') &&
    workspaceController.includes('kubernetesClusters: canReadWorkspaceData ? workspace.quota.kubernetesClusters.used : 0') &&
    workspaceController.includes('virtualMachines: canReadWorkspaceData ? workspace.quota.virtualMachines.used : 0'),
  'workspace summaries must redact counts after effective permissions are applied'
);
assert(workspaceController.includes("const permissions = getEffectiveWorkspacePermissions(req, 'owner')"), 'created workspace response must use effective permissions');
assert(
  workspaceController.includes('applyWorkspaceSummaryPermissions(createdSummary, permissions)'),
  'created workspace response must apply effective-permission redaction'
);
assert(repository.includes('m.role AS current_user_role'), 'workspace list must expose server-owned current role');
assert(matrixDoc.includes('centralized workspace authorization helpers'), 'authorization doc must mention centralized helpers');

for (const routeFile of listFiles('src/routes').filter((file) => file.endsWith('.ts'))) {
  const source = read(routeFile);
  for (const call of routeCalls(source)) {
    const args = splitTopLevelArgs(call);
    args.forEach((arg, index) => {
      if (!arg.includes('authed(')) return;
      const hasEarlierRequireUser = args.slice(0, index).some((candidate) => /\brequireUser\b/.test(candidate));
      assert(hasEarlierRequireUser, `${routeFile} has authed(...) route handler without earlier requireUser`);
    });
  }
}

console.log('Authorization checks passed.');
