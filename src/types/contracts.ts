import { z } from 'zod';
import {
  validateMcpAuthHeaderName,
  validateMcpAuthHeaderPrefix,
  validateMcpPublicAuthHeaderCollision
} from '../services/mcp-auth-config.js';
import { validateRemoteMcpEndpoint } from '../services/mcp-endpoint-policy.js';
import { validateMcpPublicHeaders as enforceMcpPublicHeaderPolicy } from '../services/mcp-public-header-policy.js';
import { autoTriageInstructionsFitLimit } from '../utils/auto-triage-instructions.js';
import { TARGET_TYPES } from './domain.js';
import { kubernetesNamespaceListSchema } from './kubernetes-namespace-contracts.js';
import { runEventSchema, runEventsBatchSchema } from './run-events-contract.js';
import { webhookUrlSchema } from './webhook-contracts.js';
export { internalMcpToolCallSchema } from './internal-mcp-contracts.js';
export {
  adminWorkspaceDefaultCreateSchema,
  adminWorkspaceDefaultDeleteSchema,
  adminWorkspaceDefaultPatchSchema
} from './workspace-default-contracts.js';

export { runEventSchema, runEventsBatchSchema };
export { registerClusterSchema, updateClusterSchema } from './kubernetes-cluster-contracts.js';
export {
  registerVirtualMachineSchema,
  updateAgentVAccessPolicySchema,
  updateVirtualMachineSchema
} from './virtual-machine-contracts.js';

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidV4Schema = z.string().regex(uuidV4Pattern, 'must be a UUIDv4');
const approvalSummarySchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const summary = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return summary || undefined;
  },
  z.string().max(240).optional()
);

export const runRequestSchema = z.object({
  contract_version: z.literal(2),
  run_id: uuidV4Schema,
  workspace_id: uuidV4Schema,
  target_id: uuidV4Schema,
  target_type: z.enum(TARGET_TYPES),
  session_id: uuidV4Schema,
  message_id: uuidV4Schema,
  requested_at: z.string().datetime()
});

export const toolResultArtifactCreateSchema = z.object({
  callId: z.string().min(1).max(256),
  toolName: z.string().min(1).max(128),
  result: z.unknown(),
  contentType: z.enum(['application/json', 'text/plain']).optional().default('application/json')
}).strict().superRefine((value, ctx) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'result')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'result is required' });
  }
  if (value.contentType === 'text/plain' && typeof value.result !== 'string') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['result'],
      message: 'plain-text artifacts require a string result'
    });
  }
});

export const platformNativeToolCallSchema = z.object({
  toolCallId: z.string().min(1).max(256),
  arguments: z.record(z.unknown()).optional().default({})
}).strict();

export const createToolApprovalSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  toolRef: z.object({
    serverId: z.string().min(1),
    toolName: z.string().min(1)
  }).strict(),
  summary: approvalSummarySchema,
  arguments: z.record(z.unknown()).optional().default({}),
  continuation: z.record(z.unknown()).optional()
});

export const toolApprovalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected'])
});

export const toolApprovalExecutionFinishedSchema = z.object({
  result: z.unknown(),
  isError: z.boolean().optional().default(false)
});

export const runCommitSchema = z.object({
  status: z.enum(['completed', 'failed', 'cancelled']),
  assistant_message: z
    .object({
      content: z.string(),
      format: z.literal('markdown')
    })
    .optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative().default(0),
    reasoning_tokens: z.preprocess(
      (value) => (value === null ? undefined : value),
      z.number().int().nonnegative().optional()
    )
  }),
  timing: z.object({
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true })
  }),
  output_artifacts: z.array(z.object({
    id: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    title: z.string().min(1).max(240)
  })).max(50).optional()
});

const assistantReferenceSchema = z.object({
  kind: z.enum(['tool', 'skill']),
  id: z.string().trim().min(1).max(256)
}).strict();

export const postMessageSchema = z.object({
  content: z.string().min(1),
  toolAccessMode: z.enum(['read_only', 'read_write']).optional(),
  clientMessageId: z.string().min(1).max(128).optional(),
  llm: z.unknown().optional(),
  references: z.array(assistantReferenceSchema).max(8).optional().default([])
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.references.forEach((reference, index) => {
    const key = `${reference.kind}:${reference.id}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['references', index], message: 'duplicate assistant reference' });
    }
    seen.add(key);
  });
});

export const createWorkspaceSchema = z.object({
  name: z.string().min(1)
});

export const workspaceRoleSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, 'must be a lowercase snake_case role key');

export const addWorkspaceMemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email().max(320),
  role: workspaceRoleSchema
});

export const createWorkspaceInvitationSchema = z.object({
  email: z.string().email(),
  role: workspaceRoleSchema,
  expiresInDays: z.number().int().min(1).max(30).optional()
});

export const updateWorkspaceMemberSchema = z.object({
  role: workspaceRoleSchema
});

export const llmProviderSchema = z.enum(['openai', 'anthropic', 'gemini']);
export const reasoningSummaryModeSchema = z.enum(['off', 'auto', 'concise', 'detailed']);
export const reasoningEffortSchema = z.enum(['off', 'low', 'medium', 'high']);

export const updateWorkspaceAiSettingsSchema = z.object({
  defaultProvider: llmProviderSchema,
  defaultModel: z.string().trim().min(1).max(160),
  reasoningSummaryMode: reasoningSummaryModeSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional()
}).strict();

export const upsertWorkspaceAiProviderCredentialSchema = z.object({
  apiKey: z.string().trim().min(1).max(4096)
}).strict();

export const createAgentVEnrollmentSchema = z.object({
  purpose: z.enum(['initial', 'replace'])
}).strict();

export const exchangeAgentVEnrollmentSchema = z.object({
  targetId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  enrollmentToken: z.string().regex(
    /^aev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/i
  ),
  purpose: z.enum(['initial', 'replace'])
}).strict();

export const createSessionSchema = z.object({
  title: z.string().min(1)
});

export const updateTargetAutoTriageSchema = z.object({
  expectedRevision: z.number().int().min(0),
  enabled: z.boolean(),
  minimumSeverity: z.enum(['critical', 'warning', 'info']),
  writeMode: z.enum(['follow_target', 'read_only', 'approval_required', 'full_write']),
  additionalInstructions: z.string().refine(autoTriageInstructionsFitLimit, {
    message: 'Additional instructions must be 4,000 normalized characters or fewer'
  }),
  namespaceInclude: kubernetesNamespaceListSchema.default([]),
  namespaceExclude: kubernetesNamespaceListSchema.default([]),
  includeClusterScopedIssues: z.boolean().optional().default(true)
}).strict();

export const startExistingAutoTriageInvestigationsSchema = z.object({
  expectedSettingsRevision: z.number().int().min(1)
}).strict();

export const internalToolingSyncSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    targetId: z.string().min(1).optional(),
    targetType: z.enum(TARGET_TYPES).optional()
  })
  .superRefine((value, ctx) => {
    const scopedFields = [value.workspaceId, value.targetId, value.targetType].filter((field) => field !== undefined);
    if (scopedFields.length > 0 && scopedFields.length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workspaceId, targetId, and targetType must be provided together'
      });
    }
  });

const adminReasonSchema = z.string().trim().min(3).max(500);
const ticketRefSchema = z.string().trim().min(1).max(128).optional();

const policyMutationFields = {
  requestId: z.string().trim().min(1).max(128).optional(),
  expectedPolicyVersion: z.number().int().nonnegative().safe().optional(),
  overLimitBehavior: z.enum(['reject', 'retain_existing']).optional(),
  source: z.enum(['admin', 'external']).optional(),
  publicReason: z.string().trim().min(1).max(500).optional()
};

function requirePolicyReceiptVersion(value: { requestId?: string; expectedPolicyVersion?: number }, context: z.RefinementCtx): void {
  if (value.requestId !== undefined && value.expectedPolicyVersion === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedPolicyVersion'], message: 'expectedPolicyVersion is required whenever requestId is supplied' });
  }
}

export const adminWorkspacePlanPatchSchema = z.object({
  ...policyMutationFields,
  planKey: z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/),
  reason: adminReasonSchema,
  ticketRef: ticketRefSchema
}).strict().superRefine(requirePolicyReceiptVersion);

const adminWorkspaceLifecycleSchema = z.object({
  ...policyMutationFields,
  workspaceName: z.string().min(1).max(200), reason: adminReasonSchema,
  ticketRef: ticketRefSchema
}).strict();
export const adminWorkspaceSuspendSchema = adminWorkspaceLifecycleSchema.superRefine(requirePolicyReceiptVersion);
export const adminWorkspaceRestoreSchema = adminWorkspaceLifecycleSchema.partial({ workspaceName: true }).superRefine(requirePolicyReceiptVersion);
const adminQuotaValueSchema = z.number().int().positive().optional();

export const adminWorkspaceQuotaPatchSchema = z.object({
  ...policyMutationFields,
  quotas: z
    .object({
      members: adminQuotaValueSchema,
      kubernetesClusters: adminQuotaValueSchema,
      virtualMachines: adminQuotaValueSchema
    })
    .strict()
    .nullable(),
  reason: adminReasonSchema,
  ticketRef: ticketRefSchema
}).strict().superRefine(requirePolicyReceiptVersion);

export const adminReasonOnlySchema = z.object({
  reason: adminReasonSchema,
  ticketRef: ticketRefSchema
}).strict();

export const adminAddWorkspaceMemberSchema = z
  .object({
    userId: z.string().min(1).optional(),
    email: z.string().email().optional(),
    role: workspaceRoleSchema,
    createUserIfMissing: z.boolean().optional().default(false),
    reason: adminReasonSchema,
    ticketRef: ticketRefSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.userId) === Boolean(value.email)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one of userId or email is required'
      });
    }
  });

export const adminUpdateWorkspaceMemberRoleSchema = z.object({
  role: workspaceRoleSchema,
  reason: adminReasonSchema,
  ticketRef: ticketRefSchema
}).strict();

export const adminDeleteWorkspaceMemberSchema = z.object({
  reason: adminReasonSchema,
  replacementOwnerUserId: z.string().min(1).optional(),
  ticketRef: ticketRefSchema
}).strict();

export const adminToolingSyncSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    targetId: z.string().min(1).optional(),
    targetType: z.enum(TARGET_TYPES).optional(),
    reason: adminReasonSchema,
    ticketRef: ticketRefSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    const scopedFields = [value.workspaceId, value.targetId, value.targetType].filter((field) => field !== undefined);
    if (scopedFields.length > 0 && scopedFields.length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workspaceId, targetId, and targetType must be provided together'
      });
    }
  });

export const adminMarkRunFailedSchema = z.object({
  errorCode: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(1000),
  reason: adminReasonSchema,
  ticketRef: ticketRefSchema,
  force: z.boolean().optional().default(false)
}).strict();

const mcpToolConfigSchema = z.object({
  name: z.string().min(1),
  timeoutMs: z.number().int().positive().max(120000).optional(),
  inputSchema: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional()
});

export const adminPlatformSettingPatchSchema = z.object({
  value: z.unknown(),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(500)
}).strict();

export const adminPlatformSettingResetSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(500)
}).strict();

export const adminLlmProviderDefaultUpsertSchema = z.object({
  apiKey: z.string().trim().min(1).max(4096),
  reason: z.string().trim().min(3).max(500)
}).strict();

export const adminLlmProviderDefaultDeleteSchema = z.object({
  reason: z.string().trim().min(3).max(500)
}).strict();

const mcpAuthTypeSchema = z.enum(['none', 'bearer_token', 'custom_header', 'oauth']);

export const mcpAuthHeaderNameSchema = z.string().superRefine((name, ctx) => {
  const error = validateMcpAuthHeaderName(name);
  if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

export const mcpAuthHeaderPrefixSchema = z.string().superRefine((prefix, ctx) => {
  const error = validateMcpAuthHeaderPrefix(prefix);
  if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

function validateMcpPublicHeaders(headers: Record<string, string> | undefined, ctx: z.RefinementCtx): void {
  try {
    enforceMcpPublicHeaderPolicy(headers);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publicHeaders'],
      message: error instanceof Error ? error.message : 'publicHeaders are invalid'
    });
  }
}

const mcpAuthConfigSchema = z
  .object({
    type: mcpAuthTypeSchema.optional(),
    headerName: mcpAuthHeaderNameSchema.optional(),
    headerPrefix: mcpAuthHeaderPrefixSchema.optional()
  })
  .strict()
  .optional();

function validateMcpAuthConfig(auth: z.infer<typeof mcpAuthConfigSchema>, ctx: z.RefinementCtx): void {
  const authType = auth?.type || 'none';
  if (authType === 'none') {
    if (auth?.headerName !== undefined || auth?.headerPrefix !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auth'],
        message: 'auth fields are not allowed when auth.type is none'
      });
    }
    return;
  }

  if (authType === 'custom_header' && !auth?.headerName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['auth', 'headerName'],
      message: 'auth.headerName is required when auth.type is custom_header'
    });
  }
  if (
    authType === 'oauth'
    && (auth?.headerName !== undefined || auth?.headerPrefix !== undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['auth'],
      message: 'OAuth does not accept auth header fields'
    });
  }
}

export const remoteMcpEndpointSchema = z.string().trim().min(1).superRefine((value, ctx) => {
  const endpointError = validateRemoteMcpEndpoint(value);
  if (endpointError) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: endpointError });
  }
});

export const createMcpServerSchema = z.object({
  name: z.string().min(1),
  url: remoteMcpEndpointSchema,
  enabled: z.boolean().optional(),
  publicHeaders: z.record(z.string()).optional(),
  credentialMode: z.enum(['none', 'workspace', 'individual']).optional(),
  auth: mcpAuthConfigSchema
}).strict().superRefine((input, ctx) => {
  validateMcpPublicHeaders(input.publicHeaders, ctx);
  validateMcpAuthConfig(input.auth, ctx);
  const authType = input.auth?.type || 'none';
  const publicAuthCollision = validateMcpPublicAuthHeaderCollision(
    input.publicHeaders,
    authType,
    input.auth?.headerName
  );
  if (publicAuthCollision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publicHeaders'],
      message: publicAuthCollision
    });
  }
  if (authType === 'none' && input.credentialMode && input.credentialMode !== 'none') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialMode'], message: 'credentialMode must be none when authentication is none' });
  }
  if (authType !== 'none' && input.credentialMode === 'none') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialMode'], message: 'authenticated MCP servers require workspace or individual credentials' });
  }
  if (authType === 'oauth' && input.credentialMode && input.credentialMode !== 'individual') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialMode'], message: 'OAuth requires individual credentials' });
  }
});

export const updateMcpServerSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  publicHeaders: z.record(z.string()).optional(),
  credentialMode: z.enum(['none', 'workspace', 'individual']).optional(),
  expectedRevision: z.number().int().positive().optional(),
  auth: mcpAuthConfigSchema
}).strict().superRefine((input, ctx) => {
  validateMcpPublicHeaders(input.publicHeaders, ctx);
  validateMcpAuthConfig(input.auth, ctx);
  if (input.auth?.type === 'oauth' && input.credentialMode && input.credentialMode !== 'individual') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialMode'], message: 'OAuth requires individual credentials' });
  }
}).refine(
  (input) => Object.keys(input).some((key) => key !== 'expectedRevision'),
  'At least one update field is required.'
);

export const updateTargetMcpServerToolSchema = z.object({
  enabled: z.boolean(),
  capability: z.enum(['read', 'write']).optional()
}).strict();

export const updateTargetToolSchema = z.object({
  enabled: z.boolean(),
  config: z.record(z.unknown()).optional()
}).strict();

export { createTargetInsightsEntrySchema, updateTargetInsightsEntrySchema } from './target-insights-contracts.js';
export {
  createTargetSkillSchema,
  importTargetSkillSchema,
  resolveGitSkillSchema,
  reimportTargetSkillSchema,
  updateTargetSkillSchema
} from './target-skill-contracts.js';
export {
  createWebhookSubscriptionSchema,
  updateWebhookSubscriptionSchema,
  webhookUrlSchema,
  webhookEventTypes,
  webhookEventTypeSchema,
  type WebhookEventType
} from './webhook-contracts.js';

export const webhookRouteConnectSchema = z.object({
  deliveryUrl: webhookUrlSchema
}).strict();

export type RunRequest = z.infer<typeof runRequestSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventsBatch = z.infer<typeof runEventsBatchSchema>;
export type RunCommit = z.infer<typeof runCommitSchema>;
