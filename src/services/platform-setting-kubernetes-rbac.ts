import type { PlatformSettingOverride } from '../store/repository-platform-settings.js';
import {
  kubernetesRbacAdditionsOverrideSchema,
  kubernetesRbacAdditionsValueSchema,
  legacyKubernetesRbacAdditionsOverride,
  mergeKubernetesRbacAdditions,
  type KubernetesRbacAdditionsOverride,
  type KubernetesRbacAdditionsValue
} from './kubernetes-rbac-additions.js';
import type { PlatformSettingState } from './platform-setting-types.js';

export function effectiveKubernetesRbacAdditions(
  deploymentDefault: KubernetesRbacAdditionsValue,
  override: KubernetesRbacAdditionsOverride
): KubernetesRbacAdditionsValue {
  return mergeKubernetesRbacAdditions(deploymentDefault, override);
}

export function parseKubernetesRbacAdditionsOverride(
  value: unknown,
  deploymentDefault: KubernetesRbacAdditionsValue
): KubernetesRbacAdditionsOverride {
  const overlay = kubernetesRbacAdditionsOverrideSchema.safeParse(value);
  if (overlay.success) return overlay.data;
  return legacyKubernetesRbacAdditionsOverride(
    deploymentDefault,
    kubernetesRbacAdditionsValueSchema.parse(value)
  );
}

export function validateKubernetesRbacAdditionsOverride(
  deploymentDefault: KubernetesRbacAdditionsValue,
  override: KubernetesRbacAdditionsOverride
): string | null {
  try {
    mergeKubernetesRbacAdditions(deploymentDefault, override);
    return null;
  } catch {
    return 'The effective Kubernetes RBAC catalog may contain at most 25 profiles.';
  }
}

/** Resolve the immutable-onboarding Kubernetes RBAC catalog setting. */
export function kubernetesRbacAdditionsState(
  entry: PlatformSettingOverride | undefined,
  deploymentProfiles: KubernetesRbacAdditionsValue['additions'],
  runtimeEditable: boolean
): PlatformSettingState<'kubernetes_rbac_additions'> {
  const deploymentDefault = kubernetesRbacAdditionsValueSchema.parse({ additions: deploymentProfiles });
  const parsed = kubernetesRbacAdditionsOverrideSchema.safeParse(entry?.overrideValue);
  const legacyParsed = kubernetesRbacAdditionsValueSchema.safeParse(entry?.overrideValue);
  const overrideValue = parsed.success
    ? parsed.data
    : legacyParsed.success
      ? legacyKubernetesRbacAdditionsOverride(deploymentDefault, legacyParsed.data)
      : undefined;
  let value = deploymentDefault;
  let warning: string | undefined;
  if (overrideValue) {
    try {
      value = effectiveKubernetesRbacAdditions(deploymentDefault, overrideValue);
    } catch {
      warning = 'The stored Kubernetes RBAC additions are invalid and were ignored.';
    }
  } else if (entry?.overrideValue !== null && entry?.overrideValue !== undefined) {
    warning = 'The stored Kubernetes RBAC additions are invalid and were ignored.';
  }
  return {
    key: 'kubernetes_rbac_additions',
    value,
    deploymentDefault,
    ...(overrideValue && !warning ? { overrideValue } : {}),
    source: overrideValue && !warning ? 'runtime_override' : 'deployment_default',
    version: entry?.version || 0,
    ...(entry?.updatedBy ? { updatedBy: entry.updatedBy } : {}),
    ...(entry?.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    editable: runtimeEditable,
    constraints: {
      maxAdditions: 25,
      maxResourcesPerAddition: 50,
      allowedVerbs: ['get', 'list', 'watch', 'create', 'patch', 'delete'],
      wildcardsAllowed: false,
      runtimeEditable
    },
    ...(warning ? { warning } : {})
  };
}
