import { z } from 'zod';

import { kubernetesRbacAdditionKeysSchema } from '../services/kubernetes-rbac-additions.js';
import { kubernetesNamespaceListSchema } from './kubernetes-namespace-contracts.js';
import { RUN_PERMISSION_MODES } from './run-permission.js';
const agentAccessModeSchema = z.string().trim().max(64).optional();

export const registerClusterSchema = z.object({
  name: z.string().min(1), agentAccessMode: agentAccessModeSchema,
  namespaceInclude: kubernetesNamespaceListSchema, namespaceExclude: kubernetesNamespaceListSchema,
  rbacAdditionKeys: kubernetesRbacAdditionKeysSchema
});

export const updateClusterSchema = z.object({
  name: z.string().min(1).optional(),
  namespaceInclude: kubernetesNamespaceListSchema,
  namespaceExclude: kubernetesNamespaceListSchema,
  permissionModeOverride: z.enum(RUN_PERMISSION_MODES).nullable().optional(),
  writeConfirmationRequiredOverride: z.boolean().nullable().optional()
}).superRefine((value, context) => {
  if (value.permissionModeOverride !== undefined && value.writeConfirmationRequiredOverride !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide permissionModeOverride or writeConfirmationRequiredOverride, not both.'
    });
  }
});
