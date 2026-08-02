import { createHash } from 'node:crypto';
import { z } from 'zod';

// Historical immutable snapshots may contain verbs for removed AgentK tools.
export const KUBERNETES_RBAC_ADDITION_VERBS = ['get', 'list', 'watch', 'create', 'patch', 'delete'] as const;

export const kubernetesRbacAdditionResourceSchema = z.object({
  apiGroup: z.string().trim().min(1).max(253)
    .regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/, 'Invalid Kubernetes API group'),
  apiVersion: z.string().trim().min(1).max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*$/, 'Invalid Kubernetes API version'),
  resource: z.string().trim().min(1).max(253)
    .regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/, 'Invalid Kubernetes resource plural'),
  kind: z.string().trim().min(1).max(128)
    .regex(/^[A-Z][A-Za-z0-9]*$/, 'Invalid Kubernetes resource kind'),
  scope: z.enum(['namespaced', 'cluster']),
  verbs: z.array(z.enum(KUBERNETES_RBAC_ADDITION_VERBS)).min(1).max(KUBERNETES_RBAC_ADDITION_VERBS.length)
    .refine((verbs) => new Set(verbs).size === verbs.length, 'RBAC verbs must not contain duplicates')
    .refine((verbs) => !verbs.includes('patch') || verbs.includes('list'), 'patch requires list so the agent can establish resource identity')
}).strict();

export const kubernetesRbacAdditionSchema = z.object({
  key: z.string().trim().min(1).max(64)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Invalid RBAC addition key'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).optional().default(''),
  resources: z.array(kubernetesRbacAdditionResourceSchema).min(1).max(50)
    .refine(
      (resources) => new Set(resources.map((item) => item.resource)).size === resources.length,
      'Kubernetes resource plurals must be unique within an RBAC addition'
    )
}).strict();

export const kubernetesRbacAdditionsValueSchema = z.object({
  additions: z.array(kubernetesRbacAdditionSchema).max(25)
    .refine((additions) => new Set(additions.map((item) => item.key)).size === additions.length, 'RBAC addition keys must not contain duplicates')
}).strict();

export const kubernetesRbacAdditionsOverrideSchema = z.object({
  upserts: z.array(kubernetesRbacAdditionSchema).max(25)
    .refine((additions) => new Set(additions.map((item) => item.key)).size === additions.length, 'RBAC addition keys must not contain duplicates'),
  disabledKeys: z.array(
    z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  ).max(25).refine(
    (keys) => new Set(keys).size === keys.length,
    'Disabled RBAC addition keys must not contain duplicates'
  )
}).strict().refine(
  (value) => value.upserts.every((addition) => !value.disabledKeys.includes(addition.key)),
  'An RBAC addition cannot be both upserted and disabled'
);

export const kubernetesRbacAdditionKeysSchema = z.array(
  z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
).max(25).refine(
  (keys) => new Set(keys).size === keys.length,
  'RBAC addition keys must not contain duplicates'
).optional();

export type KubernetesRbacAddition = z.infer<typeof kubernetesRbacAdditionSchema>;
export type KubernetesRbacAdditionsValue = z.infer<typeof kubernetesRbacAdditionsValueSchema>;
export type KubernetesRbacAdditionsOverride = z.infer<typeof kubernetesRbacAdditionsOverrideSchema>;

/** Merge deployment profiles with the administrator-authored overlay. */
export function mergeKubernetesRbacAdditions(
  deploymentDefault: KubernetesRbacAdditionsValue,
  override: KubernetesRbacAdditionsOverride
): KubernetesRbacAdditionsValue {
  const disabledKeys = new Set(override.disabledKeys);
  const upserts = new Map(override.upserts.map((addition) => [addition.key, addition]));
  const additions: KubernetesRbacAddition[] = [];

  for (const deploymentAddition of deploymentDefault.additions) {
    if (disabledKeys.has(deploymentAddition.key)) continue;
    additions.push(structuredClone(upserts.get(deploymentAddition.key) || deploymentAddition));
    upserts.delete(deploymentAddition.key);
  }
  additions.push(...[...upserts.values()].map((addition) => structuredClone(addition)));
  return kubernetesRbacAdditionsValueSchema.parse({ additions });
}

/** Interpret the original whole-catalog mutation as additive during rollout. */
export function legacyKubernetesRbacAdditionsOverride(
  _deploymentDefault: KubernetesRbacAdditionsValue,
  legacyValue: KubernetesRbacAdditionsValue
): KubernetesRbacAdditionsOverride {
  return {
    upserts: structuredClone(legacyValue.additions),
    disabledKeys: []
  };
}

/** Return a stable hash for one normalized onboarding snapshot. */
export function kubernetesRbacAdditionsHash(additions: KubernetesRbacAddition[]): string {
  return createHash('sha256').update(JSON.stringify(additions)).digest('hex');
}

/** Resolve selected bundle keys against the current platform setting. */
export function selectKubernetesRbacAdditions(
  available: KubernetesRbacAddition[],
  selectedKeys: string[]
): KubernetesRbacAddition[] {
  const byKey = new Map(available.map((addition) => [addition.key, addition]));
  return selectedKeys.map((key) => {
    const addition = byKey.get(key);
    if (!addition) throw new Error(`Unknown Kubernetes RBAC addition: ${key}`);
    return structuredClone(addition);
  });
}
