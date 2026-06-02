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
  .replaceAll("workspacesRouter.get(\n  '", "workspacesRouter.get('");
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
const migration = read('migrations/control-plane/003_workspace_membership_audit.sql');
const authzDoc = read('docs/authorization-matrix.md');

for (const routeNeedle of [
  "workspacesRouter.get('/workspaces/:workspaceId/members'",
  "workspacesRouter.post(\n  '/workspaces/:workspaceId/members'",
  "workspacesRouter.patch(\n  '/workspaces/:workspaceId/members/:userId'",
  "workspacesRouter.delete(\n  '/workspaces/:workspaceId/members/:userId'"
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
assert(migration.includes('CREATE TABLE IF NOT EXISTS workspace_membership_audit'), 'membership audit migration missing');

console.log('Workspace membership checks passed.');
