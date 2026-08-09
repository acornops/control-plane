import { z } from 'zod';
import {
  AGENTV_MAX_RESTART_SERVICES,
  AGENTV_RESTART_SERVICE_PATTERN,
  isProtectedAgentVUnit
} from './agentv-access-policy.js';
import { RUN_PERMISSION_MODES } from './run-permission.js';

const agentVRestartServiceSchema = z.string().trim().min(9).max(263)
  .regex(AGENTV_RESTART_SERVICE_PATTERN, 'must be an exact .service unit name')
  .refine((unit) => !isProtectedAgentVUnit(unit), 'must not target an AgentV service');

const agentVAccessPolicyFields = {
  agentAccessMode: z.enum(['read_only', 'read_write']),
  restartServices: z.array(agentVRestartServiceSchema)
    .max(AGENTV_MAX_RESTART_SERVICES)
    .refine((units) => new Set(units).size === units.length, 'must contain unique service units')
};

function validateAgentVAccessPolicy(
  input: { agentAccessMode: 'read_only' | 'read_write'; restartServices: string[] },
  context: z.RefinementCtx
): void {
  if (input.agentAccessMode === 'read_only' && input.restartServices.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['restartServices'], message: 'must be empty for read-only AgentV access' });
  }
  if (input.agentAccessMode === 'read_write' && input.restartServices.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['restartServices'], message: 'must include at least one service for read-write AgentV access' });
  }
}

export const registerVirtualMachineSchema = z.object({
  name: z.string().min(1),
  hostname: z.string().trim().min(1).max(253).optional(),
  osFamily: z.literal('linux').optional(),
  serviceManager: z.literal('systemd').optional(),
  allowedLogSources: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  agentAccessMode: agentVAccessPolicyFields.agentAccessMode.default('read_only'),
  restartServices: agentVAccessPolicyFields.restartServices.default([])
}).superRefine(validateAgentVAccessPolicy);

export const updateAgentVAccessPolicySchema = z.object(agentVAccessPolicyFields)
  .strict()
  .superRefine(validateAgentVAccessPolicy);

export const updateVirtualMachineSchema = z.object({
  name: z.string().min(1).optional(),
  hostname: z.string().trim().min(1).max(253).optional(),
  allowedLogSources: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  permissionModeOverride: z.enum(RUN_PERMISSION_MODES).nullable().optional()
});
