import assert from 'node:assert/strict';
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

const routeSources = [read('src/routes/workspaces.ts'), readTree('src/routes/workspaces')].join('\n');
const routes = routeSources
  .replaceAll('router.', 'workspacesRouter.')
  .replace(/\n\s+'/g, "\n  '")
  .replaceAll("workspacesRouter.get(\n  '", "workspacesRouter.get('")
  .replaceAll("workspacesRouter.post(\n  '", "workspacesRouter.post('")
  .replaceAll("workspacesRouter.patch(\n  '", "workspacesRouter.patch('")
  .replaceAll("workspacesRouter.delete(\n  '", "workspacesRouter.delete('");
const controller = [
  read('src/controllers/workspaces-controller.ts'),
  read('src/controllers/workspaces/members-controller.ts'),
  read('src/controllers/workspaces/common.ts')
].join('\n');
const repository = [
  read('src/store/repository.ts'),
  read('src/store/repository-workspaces.ts'),
  read('src/store/repository-audit-events.ts')
].join('\n');
const authorization = read('src/auth/authorization.ts');
const contracts = read('src/types/contracts.ts');
const domain = read('src/types/domain.ts');
const migration = read('migrations/control-plane/001_initial_schema.sql');
const mcpLifecycleMigration = read('migrations/control-plane/006_mcp_user_lifecycle.sql');
const authzDoc = read('docs/authorization-matrix.md');

for (const routeNeedle of [
  "workspacesRouter.get('/workspaces/:workspaceId/members'",
  "workspacesRouter.post('/workspaces/:workspaceId/members'",
  "workspacesRouter.patch('/workspaces/:workspaceId/members/:userId'",
  "workspacesRouter.delete('/workspaces/:workspaceId/members/:userId'"
]) {
  assert(routes.includes(routeNeedle), `workspace membership route missing ${routeNeedle}`);
}

for (const schemaNeedle of [
  'addWorkspaceMemberSchema',
  'updateWorkspaceMemberSchema',
  'workspaceRoleSchema',
  'lowercase snake_case role key'
]) {
  assert(contracts.includes(schemaNeedle), `workspace membership schema missing ${schemaNeedle}`);
}

assert(authorization.includes('manage_members: true'), 'built-in manager roles must have manage_members permission');
assert(authorization.includes('read_audit_log: true'), 'audit-log permissions must be modeled');
assert(authzDoc.includes('deployment-supported role templates'), 'membership policy doc missing role-template scope');

for (const controllerNeedle of [
  'requireWorkspaceCapability',
  "'manage_members'",
  'canManageMembership',
  'getWorkspacePermissions',
  'OWNER_ROLE_KEY',
  '!isProtectedRole(targetRole) && !isProtectedRole(nextRole)',
  "code: 'LAST_OWNER'",
  'PROTECTED_ROLE_REQUIRES_OWNER'
]) {
  assert(controller.includes(controllerNeedle), `workspace membership authorization missing ${controllerNeedle}`);
}

for (const repositoryNeedle of [
  'listWorkspaceMembers',
  'addWorkspaceMember',
  'updateWorkspaceMemberRole',
  'deleteWorkspaceMember',
  'recordWorkspaceMembershipAudit',
  'workspace_audit_events',
  "action: 'member_added'",
  "action: 'member_role_updated'",
  "action: 'member_removed'",
  "WHERE workspace_id = $1 AND role = 'owner'",
  "return { status: 'last_owner' }",
  'syncRoleTemplates'
]) {
  assert(repository.includes(repositoryNeedle), `workspace membership repository behavior missing ${repositoryNeedle}`);
}

assert(domain.includes('WorkspaceMembershipAuditAction'), 'domain model must include membership audit action type');
assert(migration.includes('CREATE TABLE workspace_membership_audit'), 'membership audit schema missing');

for (const needle of [
  'CREATE FUNCTION advance_workspace_member_mcp_lifecycle()',
  'AFTER INSERT OR DELETE ON workspace_memberships',
  'membership_generation=workspace_member_mcp_lifecycle.membership_generation+1',
  'workspace_member_mcp_lifecycle.blocks_readiness',
  'DROP TABLE mcp_secret_cleanup_jobs'
]) {
  assert(mcpLifecycleMigration.includes(needle), `MCP membership lifecycle schema missing ${needle}`);
}

const membershipMutationFiles = [];
function findMembershipMutations(relativePath) {
  const absolutePath = path.join(root, relativePath);
  for (const entry of readdirSync(absolutePath).sort()) {
    const child = path.join(relativePath, entry);
    const stat = statSync(path.join(root, child));
    if (stat.isDirectory()) {
      findMembershipMutations(child);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    const source = read(child);
    if (/(?:INSERT INTO|DELETE FROM)\s+workspace_memberships/i.test(source)) {
      membershipMutationFiles.push(child);
      assert(
        source.includes('readWorkspaceMemberMcpLifecycleInTransaction')
          || source.includes('MCP_LIFECYCLE_TRIGGER_PENDING'),
        `${child} mutates workspace_memberships without reading the trigger-owned generation or explicitly leaving its durable job pending`
      );
    }
  }
}
findMembershipMutations('src');
assert.deepEqual(membershipMutationFiles, [
  'src/services/workspace-provisioning.ts',
  'src/store/repository-admin.ts',
  'src/store/repository-invitations.ts',
  'src/store/repository-users.ts',
  'src/store/repository-workspaces.ts'
], 'all production membership mutation files must receive explicit lifecycle review');

const lifecycleWorker = read('src/services/mcp-user-lifecycle-worker.ts');
for (const needle of [
  "CASE WHEN lifecycle.status='removed' THEN 0 ELSE 1 END",
  "reconciliation_status='processing' AND lease_owner=$5",
  'Math.ceil(config.LLM_GATEWAY_TIMEOUT_MS / 1000) + 30',
  'Number.isSafeInteger(membershipGeneration)'
]) {
  assert(lifecycleWorker.includes(needle), `MCP membership reconciliation missing ${needle}`);
}

console.log('Workspace membership checks passed.');
