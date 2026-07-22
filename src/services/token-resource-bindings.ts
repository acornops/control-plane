import type { PromptResourceBinding } from '../types/prompt-resources.js';
import { digestBindings } from './prompt-resources/registry.js';

interface VerifiedResourceBindingClaims {
  resourceBindings: PromptResourceBinding[];
  bindingDigest?: string;
}

function operationsClaim(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('Gateway token permission resource_bindings.operations must be a string array');
  }
  if (value.length === 0 || value.length > 64
    || value.some((operation) => !operation.trim())
    || new Set(value).size !== value.length) {
    throw new Error('Gateway token resource binding operations must be unique, non-empty, and bounded');
  }
  return value;
}

function resourceBindingsClaim(value: unknown): PromptResourceBinding[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error('Gateway token permission resource_bindings must be a bounded array');
  }
  const bindings = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Gateway token resource binding entries must be objects');
    }
    const item = entry as Record<string, unknown>;
    for (const field of ['binding_id', 'type', 'resource_id', 'provider', 'provider_version', 'workspace_id', 'label_snapshot', 'source', 'context_mode']) {
      if (typeof item[field] !== 'string' || !(item[field] as string).trim()) {
        throw new Error(`Gateway token resource binding requires ${field}`);
      }
    }
    if (!['explicit', 'implicit', 'trigger'].includes(item.source as string)
      || !['inline', 'tool', 'routing_only'].includes(item.context_mode as string)) {
      throw new Error('Gateway token resource binding source or context_mode is invalid');
    }
    return {
      bindingId: item.binding_id as string,
      type: item.type as string,
      resourceId: item.resource_id as string,
      provider: item.provider as string,
      providerVersion: item.provider_version as string,
      workspaceId: item.workspace_id as string,
      labelSnapshot: item.label_snapshot as string,
      source: item.source as PromptResourceBinding['source'],
      operations: operationsClaim(item.operations),
      contextMode: item.context_mode as PromptResourceBinding['contextMode'],
      providerData: item.provider_data && typeof item.provider_data === 'object' && !Array.isArray(item.provider_data)
        ? item.provider_data as Record<string, unknown>
        : undefined
    };
  });
  if (new Set(bindings.map((binding) => binding.bindingId)).size !== bindings.length) {
    throw new Error('Gateway token resource binding IDs must be unique');
  }
  return bindings;
}

export function readResourceBindingClaims(
  permissionObject: Record<string, unknown>,
  workspaceId: string
): VerifiedResourceBindingClaims {
  const resourceBindings = resourceBindingsClaim(permissionObject.resource_bindings);
  if (permissionObject.binding_digest !== undefined && typeof permissionObject.binding_digest !== 'string') {
    throw new Error('Gateway token resource binding digest must be a string');
  }
  const bindingDigest = permissionObject.binding_digest as string | undefined;
  if (resourceBindings.length > 0 && !bindingDigest) {
    throw new Error('Gateway token resource binding digest is required');
  }
  if (bindingDigest && digestBindings(resourceBindings) !== bindingDigest) {
    throw new Error('Gateway token resource binding digest does not match its bindings');
  }
  if (resourceBindings.some((binding) => binding.workspaceId !== workspaceId)) {
    throw new Error('Gateway token resource bindings must match the token workspace');
  }
  return { resourceBindings, bindingDigest };
}

export function createResourceBindingClaims(
  resourceBindings: PromptResourceBinding[],
  bindingDigest: string | undefined,
  workspaceId: string
): Record<string, unknown> {
  if (resourceBindings.some((binding) => binding.workspaceId !== workspaceId)) {
    throw new Error('Resource bindings must match the token workspace');
  }
  if (resourceBindings.length > 64
    || new Set(resourceBindings.map((binding) => binding.bindingId)).size !== resourceBindings.length
    || resourceBindings.some((binding) => binding.operations.length === 0
      || binding.operations.length > 64
      || new Set(binding.operations).size !== binding.operations.length
      || binding.operations.some((operation) => !operation.trim()))) {
    throw new Error('Resource binding authority must be unique, non-empty, and bounded');
  }
  if (resourceBindings.length > 0 && !bindingDigest) {
    throw new Error('Resource binding digest is required');
  }
  if (bindingDigest && digestBindings(resourceBindings) !== bindingDigest) {
    throw new Error('Resource binding digest does not match its bindings');
  }
  return {
    resource_bindings: resourceBindings.map((binding) => ({
      binding_id: binding.bindingId,
      type: binding.type,
      resource_id: binding.resourceId,
      provider: binding.provider,
      provider_version: binding.providerVersion,
      workspace_id: binding.workspaceId,
      label_snapshot: binding.labelSnapshot,
      source: binding.source,
      operations: binding.operations,
      context_mode: binding.contextMode,
      ...(binding.providerData ? { provider_data: binding.providerData } : {})
    })),
    binding_digest: bindingDigest
  };
}
