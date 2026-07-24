import {
  Role,
  RoleTemplate,
  RoleTemplateCapabilityGroup,
  RoleTemplateCapabilityGroupKey,
  WorkspacePermissions as DomainWorkspacePermissions
} from '../types/domain.js';

export const WORKSPACE_CAPABILITIES = [
  'read_workspace_data',
  'read_members',
  'read_audit_log',
  'delete_workspace',
  'manage_members',
  'manage_targets',
  'manage_catalog_sources',
  'manage_mcp',
  'manage_tools',
  'manage_target_insights',
  'manage_skills',
  'manage_workflows',
  'manage_agents',
  'manage_ai_settings',
  'manage_agent_keys',
  'manage_webhooks',
  'create_sessions',
  'create_read_only_runs',
  'create_read_write_runs',
  'read_target_logs',
  'cancel_runs',
  'delete_sessions'
] as const;

export type WorkspaceCapability = typeof WORKSPACE_CAPABILITIES[number];

export type WorkspacePermissions = Record<WorkspaceCapability, boolean>;
export type TokenScope = 'read' | WorkspaceCapability;

export const DEFAULT_EXTERNAL_INTEGRATION_WORKSPACE_CAPABILITIES: WorkspaceCapability[] = [
  'read_workspace_data',
  'create_sessions',
  'create_read_only_runs'
];

export function assertExternalIntegrationWorkspaceCapabilities(capabilities: readonly string[]): WorkspaceCapability[] {
  const supported = new Set<string>(WORKSPACE_CAPABILITIES);
  const unique = [...new Set(capabilities)];
  for (const capability of unique) {
    if (!supported.has(capability)) {
      throw new Error(`Unsupported external integration workspace capability: ${capability}`);
    }
  }
  const capabilitySet = new Set(unique);
  if (capabilitySet.has('create_read_only_runs') && !capabilitySet.has('create_sessions')) {
    throw new Error('External integration create_read_only_runs requires create_sessions');
  }
  if (capabilitySet.has('create_read_write_runs') && !capabilitySet.has('create_sessions')) {
    throw new Error('External integration create_read_write_runs requires create_sessions');
  }
  if (capabilitySet.has('create_sessions') && !capabilitySet.has('read_workspace_data')) {
    throw new Error('External integration create_sessions requires read_workspace_data');
  }
  return unique as WorkspaceCapability[];
}

const WORKSPACE_CAPABILITY_GROUPS: Array<{ key: RoleTemplateCapabilityGroupKey; sortOrder: number }> = [
  { key: 'workspace', sortOrder: 0 },
  { key: 'members', sortOrder: 100 },
  { key: 'targets', sortOrder: 200 },
  { key: 'operations', sortOrder: 300 },
  { key: 'settings', sortOrder: 400 }
];

const workspaceCapabilityGroupOrder = new Map(WORKSPACE_CAPABILITY_GROUPS.map((group) => [group.key, group.sortOrder]));

export const WORKSPACE_CAPABILITY_METADATA: Record<WorkspaceCapability, { group: RoleTemplateCapabilityGroupKey; sortOrder: number }> = {
  read_workspace_data: { group: 'workspace', sortOrder: 0 },
  read_audit_log: { group: 'workspace', sortOrder: 10 },
  delete_workspace: { group: 'workspace', sortOrder: 20 },
  read_members: { group: 'members', sortOrder: 0 },
  manage_members: { group: 'members', sortOrder: 10 },
  manage_targets: { group: 'targets', sortOrder: 0 },
  read_target_logs: { group: 'targets', sortOrder: 10 },
  create_sessions: { group: 'operations', sortOrder: 0 },
  create_read_only_runs: { group: 'operations', sortOrder: 10 },
  create_read_write_runs: { group: 'operations', sortOrder: 20 },
  cancel_runs: { group: 'operations', sortOrder: 30 },
  delete_sessions: { group: 'operations', sortOrder: 40 },
  manage_catalog_sources: { group: 'settings', sortOrder: 0 },
  manage_mcp: { group: 'settings', sortOrder: 10 },
  manage_tools: { group: 'settings', sortOrder: 20 },
  manage_target_insights: { group: 'settings', sortOrder: 30 },
  manage_skills: { group: 'settings', sortOrder: 40 },
  manage_workflows: { group: 'settings', sortOrder: 50 },
  manage_agents: { group: 'settings', sortOrder: 60 },
  manage_ai_settings: { group: 'settings', sortOrder: 70 },
  manage_agent_keys: { group: 'settings', sortOrder: 80 },
  manage_webhooks: { group: 'settings', sortOrder: 90 }
};

export function groupWorkspaceCapabilities(capabilities: Iterable<keyof DomainWorkspacePermissions>): RoleTemplateCapabilityGroup[] {
  const grouped = new Map<RoleTemplateCapabilityGroupKey, WorkspaceCapability[]>();
  for (const capability of capabilities) {
    const metadata = WORKSPACE_CAPABILITY_METADATA[capability as WorkspaceCapability];
    if (!metadata) continue;
    const current = grouped.get(metadata.group) || [];
    current.push(capability as WorkspaceCapability);
    grouped.set(metadata.group, current);
  }

  return [...grouped.entries()]
    .map(([key, groupCapabilities]) => ({
      key,
      sortOrder: workspaceCapabilityGroupOrder.get(key) ?? Number.MAX_SAFE_INTEGER,
      capabilities: [...new Set(groupCapabilities)].sort((left, right) => {
        const leftOrder = WORKSPACE_CAPABILITY_METADATA[left]?.sortOrder ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = WORKSPACE_CAPABILITY_METADATA[right]?.sortOrder ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.localeCompare(right);
      })
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key));
}

export const BUILT_IN_ROLE_KEYS = ['owner', 'admin', 'operator', 'viewer', 'auditor'] as const;
export type BuiltInRoleKey = typeof BUILT_IN_ROLE_KEYS[number];
export const OWNER_ROLE_KEY: BuiltInRoleKey = 'owner';

const EMPTY_PERMISSIONS: WorkspacePermissions = {
  read_workspace_data: false,
  read_members: false,
  read_audit_log: false,
  delete_workspace: false,
  manage_members: false,
  manage_targets: false,
  manage_catalog_sources: false,
  manage_mcp: false,
  manage_tools: false,
  manage_target_insights: false,
  manage_skills: false,
  manage_workflows: false,
  manage_agents: false,
  manage_ai_settings: false,
  manage_agent_keys: false,
  manage_webhooks: false,
  create_sessions: false,
  create_read_only_runs: false,
  create_read_write_runs: false,
  read_target_logs: false,
  cancel_runs: false,
  delete_sessions: false
};

const READ_ONLY_PERMISSIONS: WorkspacePermissions = {
  read_workspace_data: true,
  read_members: true,
  read_audit_log: false,
  delete_workspace: false,
  manage_members: false,
  manage_targets: false,
  manage_catalog_sources: false,
  manage_mcp: false,
  manage_tools: false,
  manage_target_insights: false,
  manage_skills: false,
  manage_workflows: false,
  manage_agents: false,
  manage_ai_settings: false,
  manage_agent_keys: false,
  manage_webhooks: false,
  create_sessions: false,
  create_read_only_runs: false,
  create_read_write_runs: false,
  read_target_logs: false,
  cancel_runs: false,
  delete_sessions: false
};

const OWNER_PERMISSIONS: WorkspacePermissions = {
  read_workspace_data: true,
  read_members: true,
  read_audit_log: true,
  delete_workspace: true,
  manage_members: true,
  manage_targets: true,
  manage_catalog_sources: true,
  manage_mcp: true,
  manage_tools: true,
  manage_target_insights: true,
  manage_skills: true,
  manage_workflows: true,
  manage_agents: true,
  manage_ai_settings: true,
  manage_agent_keys: true,
  manage_webhooks: true,
  create_sessions: true,
  create_read_only_runs: true,
  create_read_write_runs: true,
  read_target_logs: true,
  cancel_runs: true,
  delete_sessions: true
};

const ADMIN_PERMISSIONS: WorkspacePermissions = {
  ...OWNER_PERMISSIONS,
  delete_workspace: false
};

const OPERATOR_PERMISSIONS: WorkspacePermissions = {
  ...READ_ONLY_PERMISSIONS,
  create_sessions: true,
  create_read_only_runs: true,
  read_target_logs: true,
  cancel_runs: true
};

const AUDITOR_PERMISSIONS: WorkspacePermissions = {
  ...READ_ONLY_PERMISSIONS,
  read_workspace_data: false,
  read_members: true,
  read_audit_log: true
};

export const BUILT_IN_ROLE_TEMPLATES: Record<BuiltInRoleKey, Omit<RoleTemplate, 'createdAt' | 'updatedAt'>> = {
  owner: {
    key: 'owner',
    displayName: 'Owner',
    description: 'Required governance role with full workspace control.',
    kind: 'system',
    capabilities: [...WORKSPACE_CAPABILITIES],
    protected: true,
    sortOrder: 0
  },
  admin: {
    key: 'admin',
    displayName: 'Admin',
    description: 'Manages members, targets, tools, webhooks, and run workflows without deleting the workspace.',
    kind: 'system',
    capabilities: permissionsToCapabilities(ADMIN_PERMISSIONS),
    protected: false,
    sortOrder: 100
  },
  operator: {
    key: 'operator',
    displayName: 'Operator',
    description: 'Runs read-only troubleshooting workflows and reads target logs.',
    kind: 'system',
    capabilities: permissionsToCapabilities(OPERATOR_PERMISSIONS),
    protected: false,
    sortOrder: 200
  },
  viewer: {
    key: 'viewer',
    displayName: 'Viewer',
    description: 'Reads workspace, target, session, and run data.',
    kind: 'system',
    capabilities: permissionsToCapabilities(READ_ONLY_PERMISSIONS),
    protected: false,
    sortOrder: 300
  },
  auditor: {
    key: 'auditor',
    displayName: 'Auditor',
    description: 'Reads audit logs and member context without operational workspace data.',
    kind: 'system',
    capabilities: permissionsToCapabilities(AUDITOR_PERMISSIONS),
    protected: true,
    sortOrder: 400
  }
};

const VALID_TOKEN_SCOPES = new Set<TokenScope>([
  'read',
  ...WORKSPACE_CAPABILITIES
]);

const roleTemplates = new Map<Role, RoleTemplate>();

function permissionsToCapabilities(permissions: WorkspacePermissions): WorkspaceCapability[] {
  return WORKSPACE_CAPABILITIES.filter((capability) => permissions[capability]);
}

export function capabilitiesToPermissions(capabilities: Iterable<WorkspaceCapability>): WorkspacePermissions {
  const permissions = { ...EMPTY_PERMISSIONS };
  for (const capability of capabilities) {
    permissions[capability] = true;
  }
  return permissions;
}

function sortRoleTemplates(templates: RoleTemplate[]): RoleTemplate[] {
  return [...templates].sort((left, right) => left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName));
}

function withCapabilityGroups(template: RoleTemplate): RoleTemplate {
  return {
    ...template,
    capabilities: [...template.capabilities],
    capabilityGroups: groupWorkspaceCapabilities(template.capabilities)
  };
}

export function configureRoleTemplates(templates: RoleTemplate[]): RoleTemplate[] {
  roleTemplates.clear();
  for (const template of sortRoleTemplates(templates)) {
    roleTemplates.set(template.key, withCapabilityGroups(template));
  }
  return listConfiguredRoleTemplates();
}

export function listConfiguredRoleTemplates(): RoleTemplate[] {
  return [...roleTemplates.values()].map(withCapabilityGroups);
}

export function getConfiguredRoleTemplate(role: Role | null | undefined): RoleTemplate | undefined {
  if (!role) return undefined;
  const template = roleTemplates.get(role);
  return template ? withCapabilityGroups(template) : undefined;
}

export function isSupportedRole(role: Role | null | undefined): boolean {
  return Boolean(getConfiguredRoleTemplate(role));
}

export function isProtectedRole(role: Role | null | undefined): boolean {
  return getConfiguredRoleTemplate(role)?.protected === true;
}

export function getWorkspacePermissions(role: Role | null | undefined): WorkspacePermissions {
  const template = getConfiguredRoleTemplate(role);
  if (!template) return { ...EMPTY_PERMISSIONS };
  return capabilitiesToPermissions(template.capabilities);
}

export function hasWorkspaceCapability(
  role: Role | null | undefined,
  capability: WorkspaceCapability
): boolean {
  return getWorkspacePermissions(role)[capability];
}

export function parseScopeString(scope: string): TokenScope[] {
  const parsed: TokenScope[] = [];
  const seen = new Set<TokenScope>();
  for (const rawScope of scope.split(/\s+/)) {
    if (!rawScope) {
      continue;
    }
    if (!VALID_TOKEN_SCOPES.has(rawScope as TokenScope)) {
      throw new Error(`Invalid token scope: ${rawScope}`);
    }
    const tokenScope = rawScope as TokenScope;
    if (!seen.has(tokenScope)) {
      seen.add(tokenScope);
      parsed.push(tokenScope);
    }
  }
  return parsed;
}

export function formatScopes(scopes: Iterable<TokenScope>): string {
  return [...scopes].join(' ');
}

export function scopesIncludeAll(availableScopes: Iterable<TokenScope>, requestedScopes: Iterable<TokenScope>): boolean {
  const available = new Set(availableScopes);
  return [...requestedScopes].every((scope) => available.has(scope));
}

export function hasEffectiveWorkspaceCapability(
  role: Role | null | undefined,
  capability: WorkspaceCapability,
  tokenScopes: Set<TokenScope>
): boolean {
  return hasWorkspaceCapability(role, capability) && tokenScopes.has(capability);
}

configureRoleTemplates(Object.values(BUILT_IN_ROLE_TEMPLATES));
