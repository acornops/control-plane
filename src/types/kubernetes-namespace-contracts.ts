import { z } from 'zod';

export const kubernetesNamespaceSchema = z.string().trim().min(1).max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Invalid Kubernetes namespace');
export const kubernetesNamespaceListSchema = z.array(kubernetesNamespaceSchema).max(100).refine(
  (values) => new Set(values).size === values.length,
  'Namespace list must not contain duplicates'
).optional();
