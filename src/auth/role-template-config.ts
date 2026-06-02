import { z } from 'zod';
import {
  BUILT_IN_ROLE_KEYS,
  BUILT_IN_ROLE_TEMPLATES,
  OWNER_ROLE_KEY,
  WORKSPACE_CAPABILITIES,
  WorkspaceCapability,
  configureRoleTemplates
} from './authorization.js';
import { RoleTemplate } from '../types/domain.js';

const roleKeyPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const builtInRoleKeys = new Set<string>(BUILT_IN_ROLE_KEYS);
const workspaceCapabilities = new Set<string>(WORKSPACE_CAPABILITIES);
const ownerOnlyCapabilities = new Set<WorkspaceCapability>(['delete_workspace']);

const customRoleTemplateSchema = z.object({
  key: z.string().regex(roleKeyPattern),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  capabilities: z.array(z.enum(WORKSPACE_CAPABILITIES)).min(1),
  sortOrder: z.number().int().min(1).max(10000).optional()
}).strict();

const workspaceRolesConfigSchema = z.object({
  enabledBuiltIns: z.array(z.string()).optional(),
  customTemplates: z.array(customRoleTemplateSchema).default([])
}).strict().default({});

export type WorkspaceRolesConfig = z.infer<typeof workspaceRolesConfigSchema>;

function parseWorkspaceRolesJson(raw: string | undefined): unknown {
  if (!raw || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed === null ? {} : parsed;
  } catch (err) {
    throw new Error(`WORKSPACE_ROLES_CONFIG_JSON must be valid JSON: ${(err as Error).message}`);
  }
}

export function resolveWorkspaceRoleTemplates(rawJson: string | undefined): RoleTemplate[] {
  const parsed = workspaceRolesConfigSchema.parse(parseWorkspaceRolesJson(rawJson));
  const enabledBuiltIns = parsed.enabledBuiltIns ?? [...BUILT_IN_ROLE_KEYS];
  const seen = new Set<string>();
  for (const key of enabledBuiltIns) {
    if (!builtInRoleKeys.has(key)) {
      throw new Error(`Unknown built-in workspace role: ${key}`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate built-in workspace role: ${key}`);
    }
    seen.add(key);
  }
  if (!seen.has(OWNER_ROLE_KEY)) {
    throw new Error('workspaceRoles.enabledBuiltIns must include owner');
  }

  const templates: RoleTemplate[] = enabledBuiltIns.map((key) => ({ ...BUILT_IN_ROLE_TEMPLATES[key as keyof typeof BUILT_IN_ROLE_TEMPLATES] }));
  for (const custom of parsed.customTemplates) {
    if (builtInRoleKeys.has(custom.key)) {
      throw new Error(`Custom workspace role duplicates reserved built-in role: ${custom.key}`);
    }
    if (seen.has(custom.key)) {
      throw new Error(`Duplicate workspace role template: ${custom.key}`);
    }
    for (const capability of custom.capabilities) {
      if (!workspaceCapabilities.has(capability)) {
        throw new Error(`Unknown workspace capability for ${custom.key}: ${capability}`);
      }
      if (ownerOnlyCapabilities.has(capability)) {
        throw new Error(`Custom workspace role ${custom.key} may not include owner-only capability ${capability}`);
      }
    }
    seen.add(custom.key);
    templates.push({
      key: custom.key,
      displayName: custom.displayName,
      description: custom.description,
      kind: 'custom',
      capabilities: [...new Set(custom.capabilities)],
      protected: false,
      sortOrder: custom.sortOrder ?? 1000
    });
  }
  return templates.sort((left, right) => left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName));
}

export function configureWorkspaceRoleTemplates(rawJson: string | undefined): RoleTemplate[] {
  return configureRoleTemplates(resolveWorkspaceRoleTemplates(rawJson));
}
