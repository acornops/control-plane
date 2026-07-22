import {
  assertExternalIntegrationWorkspaceCapabilities,
  DEFAULT_EXTERNAL_INTEGRATION_WORKSPACE_CAPABILITIES,
  type WorkspaceCapability
} from './auth/authorization.js';

const PLACEHOLDER_VALUES = new Set([
  'change-me',
  'changeme',
  'replace-me',
  'replace_me',
  'placeholder',
  'example'
]);

export interface ExternalIntegrationClientDescriptor {
  id: string;
  provider: string;
  displayName: string;
  sha256: string;
  enabled: boolean;
  allowedCapabilities: WorkspaceCapability[];
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

function isUnsafeDescriptorValue(value: string): boolean {
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

function parseSlug(value: unknown, field: string, index: number): string {
  const slug = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(slug)) {
    throw new Error(`External integration client at index ${index} has invalid ${field}`);
  }
  return slug;
}

export function parseExternalIntegrationClientDescriptors(
  raw: string | undefined,
  nodeEnv = process.env.NODE_ENV
): ExternalIntegrationClientDescriptor[] {
  const entries = parseJsonArray(raw, 'EXTERNAL_INTEGRATION_CLIENTS_JSON');
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  const descriptors: ExternalIntegrationClientDescriptor[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`External integration client at index ${index} must be an object`);
    }
    const value = entry as Record<string, unknown>;
    const id = parseSlug(value.id, 'id', index);
    if (seenIds.has(id)) {
      throw new Error(`Duplicate external integration client id: ${id}`);
    }
    seenIds.add(id);

    const provider = parseSlug(value.provider, 'provider', index);
    const displayName = typeof value.displayName === 'string' ? value.displayName.trim() : '';
    if (displayName.length === 0 || displayName.length > 120) {
      throw new Error(`External integration client ${id} must include a displayName`);
    }

    const sha256 = typeof value.sha256 === 'string' ? value.sha256.trim() : '';
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`External integration client ${id} must include a lowercase SHA-256 digest`);
    }
    if (seenHashes.has(sha256)) {
      throw new Error(`Duplicate external integration client token hash for ${id}`);
    }
    seenHashes.add(sha256);

    if (
      nodeEnv === 'production' &&
      (isUnsafeDescriptorValue(id) || isUnsafeDescriptorValue(provider) || isUnsafeDescriptorValue(displayName) || isUnsafeDescriptorValue(sha256))
    ) {
      throw new Error(`External integration client ${id} uses an unsafe placeholder value`);
    }

    const rawAllowedCapabilities = value.allowedCapabilities === undefined
      ? DEFAULT_EXTERNAL_INTEGRATION_WORKSPACE_CAPABILITIES
      : Array.isArray(value.allowedCapabilities)
        ? value.allowedCapabilities
        : (() => {
            throw new Error(`External integration client ${id} allowedCapabilities must be an array`);
          })();
    const allowedCapabilities = assertExternalIntegrationWorkspaceCapabilities(
      rawAllowedCapabilities.map((capability) => typeof capability === 'string' ? capability.trim() : '')
    );

    descriptors.push({
      id,
      provider,
      displayName,
      sha256,
      enabled: value.enabled !== false,
      allowedCapabilities
    });
  }
  return descriptors;
}
