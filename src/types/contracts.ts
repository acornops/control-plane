import { z } from 'zod';
import { validateMcpPublicHeaders as enforceMcpPublicHeaderPolicy } from '../services/mcp-public-header-policy.js';
import { TARGET_TYPES } from './domain.js';
import { runEventSchema, runEventsBatchSchema } from './run-events-contract.js';
import { webhookUrlSchema } from './webhook-contracts.js';

export { runEventSchema, runEventsBatchSchema };

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
  email: z.string().email(),
  displayName: z.string().min(1).max(160).optional(),
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

const namespaceSchema = z.string().trim().min(1).max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Invalid Kubernetes namespace');
const namespaceListSchema = z.array(namespaceSchema).max(100).refine(
  (values) => new Set(values).size === values.length,
  'Namespace list must not contain duplicates'
).optional();
const agentAccessModeSchema = z.string().trim().max(64).optional();

export const registerClusterSchema = z.object({
  name: z.string().min(1),
  agentAccessMode: agentAccessModeSchema,
  namespaceInclude: namespaceListSchema,
  namespaceExclude: namespaceListSchema
});

export const updateClusterSchema = z.object({
  name: z.string().min(1).optional(),
  namespaceInclude: namespaceListSchema,
  namespaceExclude: namespaceListSchema,
  writeConfirmationRequiredOverride: z.boolean().nullable().optional()
});

export const registerVirtualMachineSchema = z.object({
  name: z.string().min(1),
  hostname: z.string().trim().min(1).max(253).optional(),
  osFamily: z.literal('linux').optional(),
  serviceManager: z.literal('systemd').optional(),
  allowedLogSources: z.array(z.string().trim().min(1).max(64)).max(10).optional()
});

export const updateVirtualMachineSchema = z.object({
  name: z.string().min(1).optional(),
  hostname: z.string().trim().min(1).max(253).optional(),
  allowedLogSources: z.array(z.string().trim().min(1).max(64)).max(10).optional()
});

export const createSessionSchema = z.object({
  title: z.string().min(1)
});

export const internalMcpToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.unknown()).optional().default({}),
  toolCallId: z.string().min(1).max(256).optional()
});

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

export const adminWorkspacePlanPatchSchema = z.object({
  planKey: z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/),
  reason: adminReasonSchema,
  ticketRef: ticketRefSchema
}).strict();

export const adminWorkspaceSuspendSchema = z.object({
  workspaceName: z.string().min(1).max(200), reason: adminReasonSchema,
  ticketRef: ticketRefSchema
}).strict();
export const adminWorkspaceRestoreSchema = adminWorkspaceSuspendSchema.partial({ workspaceName: true });
const adminQuotaValueSchema = z.number().int().positive().optional();

export const adminWorkspaceQuotaPatchSchema = z.object({
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
}).strict();

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

const mcpAuthTypeSchema = z.enum(['none', 'bearer_token', 'custom_header']);

const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const reservedHeaderNames = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
  'x-workspace-id',
  'x-target-id',
  'x-target-type',
  'x-run-id',
  'x-tool-name'
]);
function validateHeaderName(name: string, ctx: z.RefinementCtx, path: Array<string | number>): string | null {
  if (name !== name.trim() || name.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'header name must not be empty or padded' });
    return null;
  }
  if (name.length > 128) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'header name must be 128 characters or fewer' });
    return null;
  }
  if (!headerNamePattern.test(name)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'header name must be a valid HTTP header token' });
    return null;
  }
  return name.toLowerCase();
}

function validateHeaderValue(value: string, ctx: z.RefinementCtx, path: Array<string | number>, label: string): void {
  if (value.length > 4096) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `${label} must be 4096 characters or fewer` });
  }
  if (/[\r\n]/.test(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `${label} must not contain CR or LF characters` });
  }
}

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
    headerName: z.string().min(1).optional(),
    headerPrefix: z.string().optional()
  })
  .strict()
  .optional();

function validateMcpAuthConfig(auth: z.infer<typeof mcpAuthConfigSchema>, ctx: z.RefinementCtx): void {
  const authType = auth?.type || 'none';
  if (auth?.headerName) {
    const normalized = validateHeaderName(auth.headerName, ctx, ['auth', 'headerName']);
    if (normalized && reservedHeaderNames.has(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auth', 'headerName'],
        message: 'auth.headerName is reserved by the platform'
      });
    }
  }
  if (auth?.headerPrefix !== undefined) {
    validateHeaderValue(auth.headerPrefix, ctx, ['auth', 'headerPrefix'], 'auth.headerPrefix');
  }
  if (authType === 'none') {
    if (auth?.headerName || auth?.headerPrefix) {
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
}

export const createMcpServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  enabled: z.boolean().optional(),
  publicHeaders: z.record(z.string()).optional(),
  credentialMode: z.enum(['none', 'workspace', 'individual']).optional(),
  auth: mcpAuthConfigSchema
}).strict().superRefine((input, ctx) => {
  validateMcpPublicHeaders(input.publicHeaders, ctx);
  validateMcpAuthConfig(input.auth, ctx);
  const authType = input.auth?.type || 'none';
  if (authType === 'none' && input.credentialMode && input.credentialMode !== 'none') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialMode'], message: 'credentialMode must be none when authentication is none' });
  }
  if (authType !== 'none' && input.credentialMode === 'none') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialMode'], message: 'authenticated MCP servers require workspace or individual credentials' });
  }
});

export const updateMcpServerSchema = z.object({
  url: z.string().url().optional(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  publicHeaders: z.record(z.string()).optional(),
  credentialMode: z.enum(['none', 'workspace', 'individual']).optional(),
  expectedRevision: z.number().int().positive().optional(),
  auth: mcpAuthConfigSchema,
  tools: z.array(mcpToolConfigSchema).optional(),
  removeTools: z.array(z.string().min(1)).optional()
}).strict().superRefine((input, ctx) => {
  validateMcpPublicHeaders(input.publicHeaders, ctx);
  validateMcpAuthConfig(input.auth, ctx);
});

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
