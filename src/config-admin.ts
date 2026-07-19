import { z } from 'zod';
import { httpsUrlProductionIssues, oidcIssuerProductionIssues } from './config-url-policy.js';
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

const emptyToUndefined = (value: unknown): unknown => typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const booleanFromEnv = (defaultValue: boolean) => z.preprocess((value) => {
  if (value === undefined || value === '') return defaultValue;
  if (typeof value === 'string') {
    if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) return true;
    if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) return false;
  }
  return value;
}, z.boolean());

export const platformAdminConfigFields = {
  CONTROL_PLANE_ADMIN_API_ENABLED: booleanFromEnv(false),
  CONTROL_PLANE_ADMIN_TOKENS_JSON: z.string().default('[]'),
  CONTROL_PLANE_ADMIN_AUTH_FAILURE_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  CONTROL_PLANE_ADMIN_AUTH_FAILURE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(20),
  CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED: booleanFromEnv(false),
  PLATFORM_ADMIN_BFF_TOKEN_ID: z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/).default('platform-admin-console'),
  PLATFORM_ADMIN_CONSOLE_BASE_URL: z.string().url().default('http://localhost:4173'),
  ADMIN_SESSION_COOKIE_NAME: z.string().default('__Host-acornops_admin_session'),
  ADMIN_SESSION_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(3600),
  ADMIN_SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
  ADMIN_SESSION_REAUTH_SECONDS: z.coerce.number().int().positive().default(900),
  ADMIN_CSRF_COOKIE_NAME: z.string().default('__Host-acornops_admin_csrf'),
  ADMIN_CSRF_HEADER_NAME: z.string().default('x-csrf-token'),
  ADMIN_CSRF_SECRET: z.string().default('dev_admin_csrf_secret_change_me_32_bytes_minimum'),
  ADMIN_OIDC_PROVIDER_NAME: z.string().default('oidc'),
  ADMIN_OIDC_ISSUER_URL: z.string().url().default('http://localhost:8080/realms/acornops'),
  ADMIN_OIDC_PUBLIC_ISSUER_URL: optionalUrl,
  ADMIN_OIDC_CLIENT_ID: z.string().default('acornops-platform-admin'),
  ADMIN_OIDC_CLIENT_SECRET: optionalString,
  ADMIN_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
  ADMIN_OIDC_AUTHORIZATION_ENDPOINT_OVERRIDE: optionalUrl,
  ADMIN_OIDC_TOKEN_ENDPOINT_OVERRIDE: optionalUrl,
  ADMIN_OIDC_JWKS_URI_OVERRIDE: optionalUrl,
  ADMIN_OIDC_REDIRECT_URI: z.string().url().default('http://localhost:8081/admin-auth/oidc/callback'),
  ADMIN_OIDC_SCOPES: z.string().default('openid profile email'),
  ADMIN_OIDC_ALLOWED_ROLES: z.string().default('platform-admin,platform-admin-viewer,platform-admin-auditor'),
  ADMIN_OIDC_REQUIRED_ACR_VALUES: z.string().default(''),
  ADMIN_OIDC_REQUIRED_AMR_VALUES: z.string().default('mfa,webauthn,hwk'),
  ADMIN_OIDC_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10000)
};

type PlatformAdminConfig = z.infer<z.ZodObject<typeof platformAdminConfigFields>> & { NODE_ENV: string };
export function platformAdminConfigIssues(value: PlatformAdminConfig, descriptors: AdminTokenDescriptor[]): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  const add = (field: string, message: string): void => { issues.push({ field, message }); };
  if (value.ADMIN_SESSION_IDLE_TIMEOUT_SECONDS > value.ADMIN_SESSION_MAX_AGE_SECONDS) add('ADMIN_SESSION_IDLE_TIMEOUT_SECONDS', 'ADMIN_SESSION_IDLE_TIMEOUT_SECONDS must be less than or equal to ADMIN_SESSION_MAX_AGE_SECONDS');
  if (value.ADMIN_SESSION_REAUTH_SECONDS > value.ADMIN_SESSION_MAX_AGE_SECONDS) add('ADMIN_SESSION_REAUTH_SECONDS', 'ADMIN_SESSION_REAUTH_SECONDS must be less than or equal to ADMIN_SESSION_MAX_AGE_SECONDS');
  if (value.NODE_ENV !== 'production' || !value.CONTROL_PLANE_ADMIN_API_ENABLED || !value.CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED) return issues;
  if (!descriptors.some((descriptor) => descriptor.enabled && descriptor.id === value.PLATFORM_ADMIN_BFF_TOKEN_ID)) add('PLATFORM_ADMIN_BFF_TOKEN_ID', 'PLATFORM_ADMIN_BFF_TOKEN_ID must identify an enabled platform-admin BFF token descriptor');
  for (const issue of httpsUrlProductionIssues('PLATFORM_ADMIN_CONSOLE_BASE_URL', value.PLATFORM_ADMIN_CONSOLE_BASE_URL)) add(issue.field, issue.message);
  for (const issue of httpsUrlProductionIssues('ADMIN_OIDC_REDIRECT_URI', value.ADMIN_OIDC_REDIRECT_URI)) add(issue.field, issue.message);
  for (const issue of oidcIssuerProductionIssues(value.ADMIN_OIDC_ISSUER_URL, value.ADMIN_OIDC_PUBLIC_ISSUER_URL)) add(issue.field, issue.message);
  for (const [field, secret] of [['ADMIN_OIDC_CLIENT_SECRET', value.ADMIN_OIDC_CLIENT_SECRET], ['ADMIN_CSRF_SECRET', value.ADMIN_CSRF_SECRET]] as const) {
    if (!secret || secret.length < 32 || isUnsafeAdminDescriptorValue(secret)) add(field, `${field} must be a generated production secret`);
  }
  const roles = value.ADMIN_OIDC_ALLOWED_ROLES.split(',').map((item) => item.trim()).filter(Boolean).sort();
  const requiredRoles = ['platform-admin', 'platform-admin-auditor', 'platform-admin-viewer'];
  if (roles.length !== requiredRoles.length || roles.some((role, index) => role !== requiredRoles[index])) add('ADMIN_OIDC_ALLOWED_ROLES', 'Production admin OIDC roles must be exactly platform-admin, platform-admin-viewer, and platform-admin-auditor');
  if (!value.ADMIN_SESSION_COOKIE_NAME.startsWith('__Host-')) add('ADMIN_SESSION_COOKIE_NAME', 'Production admin session cookie must use the __Host- prefix');
  if (!value.ADMIN_CSRF_COOKIE_NAME.startsWith('__Host-')) add('ADMIN_CSRF_COOKIE_NAME', 'Production admin CSRF cookie must use the __Host- prefix');
  if (new URL(value.ADMIN_OIDC_REDIRECT_URI).origin !== new URL(value.PLATFORM_ADMIN_CONSOLE_BASE_URL).origin) add('ADMIN_OIDC_REDIRECT_URI', 'Admin OIDC callback must use the platform admin console origin');
  if (!value.ADMIN_OIDC_REQUIRED_ACR_VALUES.trim() && !value.ADMIN_OIDC_REQUIRED_AMR_VALUES.trim()) add('ADMIN_OIDC_REQUIRED_AMR_VALUES', 'Production admin OIDC must require an MFA assurance claim');
  return issues;
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
