import type { WorkspacePlan } from './types/domain.js';

const PLACEHOLDER_VALUES = new Set([
  'change-me',
  'changeme',
  'replace-me',
  'replace_me',
  'replace-me-with-32-byte-base64',
  'dev_csrf_secret_change_me_32_bytes_minimum',
  'dev_orchestrator_token',
  'dev_execution_engine_dispatch_token',
  'acornops-control-plane-secret',
  'acornops'
]);

export const ADMIN_SCOPE_VALUES = [
  'admin:*',
  'admin:self',
  'admin:system:read',
  'admin:audit:read',
  'admin:workspace:read',
  'admin:workspace:write',
  'admin:user:read',
  'admin:user:write',
  'admin:member:write',
  'admin:target:read',
  'admin:target:write',
  'admin:agent-key:rotate',
  'admin:tooling:write',
  'admin:run:read',
  'admin:run:write'
] as const;

export type AdminScope = typeof ADMIN_SCOPE_VALUES[number];

export interface AdminTokenDescriptor {
  id: string;
  name?: string;
  sha256: string;
  scopes: AdminScope[];
  enabled: boolean;
}

export interface WorkspacePlanDefinition extends WorkspacePlan {
  quotas: {
    members: number;
    kubernetesClusters: number;
    virtualMachines: number;
  };
}

function isUnsafeAdminDescriptorValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    PLACEHOLDER_VALUES.has(normalized) ||
    normalized.includes('change-me') ||
    normalized.includes('replace-me') ||
    normalized.includes('placeholder') ||
    normalized.includes('example')
  );
}

function parseJsonArray(raw: string | undefined, label: string): unknown[] {
  if (!raw || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return parsed;
}

export function parseAdminTokenDescriptors(raw: string | undefined, nodeEnv = process.env.NODE_ENV): AdminTokenDescriptor[] {
  const entries = parseJsonArray(raw, 'CONTROL_PLANE_ADMIN_TOKENS_JSON');
  const supportedScopes = new Set<string>(ADMIN_SCOPE_VALUES);
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  const descriptors: AdminTokenDescriptor[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Admin token descriptor at index ${index} must be an object`);
    }
    const value = entry as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(id)) {
      throw new Error(`Admin token descriptor at index ${index} has invalid id`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate admin token descriptor id: ${id}`);
    }
    seenIds.add(id);

    const sha256 = typeof value.sha256 === 'string' ? value.sha256.trim() : '';
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Admin token descriptor ${id} must include a lowercase SHA-256 digest`);
    }
    if (seenHashes.has(sha256)) {
      throw new Error(`Duplicate admin token descriptor hash for ${id}`);
    }
    seenHashes.add(sha256);
    if (nodeEnv === 'production' && (isUnsafeAdminDescriptorValue(id) || isUnsafeAdminDescriptorValue(sha256))) {
      throw new Error(`Admin token descriptor ${id} uses an unsafe placeholder value`);
    }

    if (!Array.isArray(value.scopes) || value.scopes.length === 0) {
      throw new Error(`Admin token descriptor ${id} must include at least one scope`);
    }
    const scopes: AdminScope[] = [];
    for (const scope of value.scopes) {
      if (typeof scope !== 'string' || !supportedScopes.has(scope)) {
        throw new Error(`Admin token descriptor ${id} includes unsupported scope`);
      }
      if (!scopes.includes(scope as AdminScope)) {
        scopes.push(scope as AdminScope);
      }
    }
    const name = typeof value.name === 'string' && value.name.trim().length > 0 ? value.name.trim() : undefined;
    descriptors.push({ id, ...(name ? { name } : {}), sha256, scopes, enabled: value.enabled !== false });
  }
  return descriptors;
}

function defaultWorkspacePlans(): WorkspacePlanDefinition[] {
  return [
    {
      key: 'default',
      name: 'Default',
      quotas: {
        members: 100,
        kubernetesClusters: 30,
        virtualMachines: 30
      }
    }
  ];
}

export function parseWorkspacePlansConfig(raw: string | undefined): {
  defaultPlanKey: string;
  plans: WorkspacePlanDefinition[];
} {
  if (!raw || raw.trim() === '') {
    return { defaultPlanKey: 'default', plans: defaultWorkspacePlans() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WORKSPACE_PLANS_CONFIG_JSON must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WORKSPACE_PLANS_CONFIG_JSON must be an object');
  }
  const input = parsed as Record<string, unknown>;
  const defaultPlanKey = typeof input.defaultPlanKey === 'string' ? input.defaultPlanKey.trim() : 'default';
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(defaultPlanKey)) {
    throw new Error('WORKSPACE_PLANS_CONFIG_JSON defaultPlanKey is invalid');
  }
  if (!Array.isArray(input.plans) || input.plans.length === 0) {
    throw new Error('WORKSPACE_PLANS_CONFIG_JSON must include at least one plan');
  }
  const seen = new Set<string>();
  const plans = input.plans.map((entry, index): WorkspacePlanDefinition => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Workspace plan at index ${index} must be an object`);
    }
    const value = entry as Record<string, unknown>;
    const key = typeof value.key === 'string' ? value.key.trim() : '';
    if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(key)) {
      throw new Error(`Workspace plan at index ${index} has invalid key`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate workspace plan key: ${key}`);
    }
    seen.add(key);
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name) {
      throw new Error(`Workspace plan ${key} must include a display name`);
    }
    const quotas = value.quotas && typeof value.quotas === 'object' && !Array.isArray(value.quotas)
      ? value.quotas as Record<string, unknown>
      : {};
    const members = Number(quotas.members);
    const kubernetesClusters = Number(quotas.kubernetesClusters);
    const virtualMachines = Number(quotas.virtualMachines);
    if (![members, kubernetesClusters, virtualMachines].every((quota) => Number.isInteger(quota) && quota > 0)) {
      throw new Error(`Workspace plan ${key} quotas must be positive integers`);
    }
    return { key, name, quotas: { members, kubernetesClusters, virtualMachines } };
  });
  if (!seen.has(defaultPlanKey)) {
    throw new Error('WORKSPACE_PLANS_CONFIG_JSON must include the default plan');
  }
  return { defaultPlanKey, plans };
}
