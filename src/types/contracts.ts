import { z } from 'zod';
import { TARGET_TYPES } from './domain.js';

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
  contract_version: z.number().int().default(1),
  run_id: uuidV4Schema,
  workspace_id: uuidV4Schema,
  target_id: uuidV4Schema,
  target_type: z.enum(TARGET_TYPES),
  session_id: uuidV4Schema,
  message_id: uuidV4Schema,
  requested_at: z.string().datetime()
});

export const runEventSchema = z.object({
  schema_version: z.literal(1),
  run_id: uuidV4Schema,
  seq: z.number().int().positive(),
  ts: z.string().datetime(),
  type: z.string().min(1),
  payload: z.record(z.unknown())
});

export const runEventsBatchSchema = z.object({
  events: z.array(runEventSchema)
});

export const createToolApprovalSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
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
  })
});

export const postMessageSchema = z.object({
  content: z.string().min(1),
  toolAccessMode: z.enum(['read_only', 'read_write']).optional(),
  clientMessageId: z.string().min(1).max(128).optional(),
  llm: z.unknown().optional()
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

const namespaceListSchema = z.array(z.string().trim().min(1).max(253)).max(100).optional();
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
  arguments: z.record(z.unknown()).optional().default({})
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
const publicHeaderDeniedNames = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token'
]);
const publicHeaderDeniedPatterns = ['token', 'secret', 'credential', 'api-key', 'apikey'];

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

function effectiveAuthHeaderPrefix(authType: z.infer<typeof mcpAuthTypeSchema>, headerPrefix: string | undefined): string {
  if (authType === 'bearer_token') return 'Bearer ';
  return headerPrefix ?? '';
}

function validateMcpPublicHeaders(headers: Record<string, string> | undefined, ctx: z.RefinementCtx): void {
  if (!headers) return;
  const entries = Object.entries(headers);
  if (entries.length > 64) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['publicHeaders'], message: 'publicHeaders may include at most 64 headers' });
    return;
  }
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    const normalized = validateHeaderName(name, ctx, ['publicHeaders', name]);
    if (!normalized) continue;
    if (seen.has(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publicHeaders', name],
        message: 'duplicate exposed header name'
      });
    }
    seen.add(normalized);
    if (reservedHeaderNames.has(normalized)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['publicHeaders', name], message: 'exposed header is reserved by the platform' });
    }
    if (publicHeaderDeniedNames.has(normalized) || publicHeaderDeniedPatterns.some((pattern) => normalized.includes(pattern))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['publicHeaders', name], message: 'exposed header may not contain credentials' });
    }
    validateHeaderValue(value, ctx, ['publicHeaders', name], 'exposed header value');
  }
}

const mcpAuthConfigSchema = z
  .object({
    type: mcpAuthTypeSchema.optional(),
    secretName: z.string().min(1).optional(),
    secretValue: z.string().min(1).optional(),
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
  if (auth?.secretValue !== undefined) {
    validateHeaderValue(auth.secretValue, ctx, ['auth', 'secretValue'], 'auth.secretValue');
    validateHeaderValue(`${effectiveAuthHeaderPrefix(authType, auth.headerPrefix)}${auth.secretValue}`, ctx, ['auth', 'secretValue'], 'auth header value');
  }

  if (authType === 'none') {
    if (auth?.secretName || auth?.secretValue || auth?.headerName || auth?.headerPrefix) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auth'],
        message: 'auth fields are not allowed when auth.type is none'
      });
    }
    return;
  }

  if (!auth?.secretName && !auth?.secretValue) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['auth'],
      message: 'auth.secretName or auth.secretValue is required when auth.type is bearer_token or custom_header'
    });
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
  auth: mcpAuthConfigSchema
}).strict().superRefine((input, ctx) => {
  validateMcpPublicHeaders(input.publicHeaders, ctx);
  validateMcpAuthConfig(input.auth, ctx);
});

export const updateMcpServerSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  publicHeaders: z.record(z.string()).optional(),
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

export { createKnowledgeBankEntrySchema, updateKnowledgeBankEntrySchema } from './knowledge-bank-contracts.js';

const targetSkillFileSchema = z.object({
  path: z.string().trim().min(1).max(512),
  content: z.string().max(32768)
}).strict();

export const createTargetSkillSchema = z.object({
  files: z.array(targetSkillFileSchema).min(1).max(16)
}).strict();

export const importTargetSkillSchema = z.object({
  repoUrl: z.string().url(),
  ref: z.string().trim().min(1).max(255).optional(),
  subpath: z.string().trim().min(1).max(512).optional(),
  enabled: z.boolean().optional()
}).strict();

export const updateTargetSkillSchema = z.object({
  enabled: z.boolean().optional(),
  files: z.array(targetSkillFileSchema).min(1).max(16).optional()
}).strict().refine((input) => input.enabled !== undefined || input.files !== undefined, {
  message: 'at least one field is required'
});

export const reimportTargetSkillSchema = z.object({
  force: z.boolean().optional().default(false)
}).strict();

export const webhookEventTypes = [
  'workspace.created.v1',
  'workspace.deleted.v1',
  'target.registered.v1',
  'target.updated.v1',
  'target.deleted.v1',
  'target.status_changed.v1',
  'agent.connected.v1',
  'agent.disconnected.v1',
  'agent.capabilities_changed.v1',
  'agent.key_rotated.v1',
  'session.created.v1',
  'session.deleted.v1',
  'message.received.v1',
  'run.created.v1',
  'run.started.v1',
  'run.completed.v1',
  'run.failed.v1',
  'run.cancelled.v1',
  'run.cancel_requested.v1',
  'run.tool_approval_requested.v1',
  'run.tool_approval_decided.v1',
  'tool.called.v1',
  'mcp.server.created.v1',
  'mcp.server.updated.v1',
  'mcp.server.deleted.v1',
  'mcp.server.tested.v1',
  'tool.catalog.changed.v1'
] as const;

export const webhookEventTypeSchema = z.enum(webhookEventTypes);

const webhookUrlSchema = z.string().url().refine(
  (value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  },
  {
    message: 'webhook URL must use https and must not include credentials'
  }
);

export const createWebhookSubscriptionSchema = z.object({
  name: z.string().min(1).max(120),
  url: webhookUrlSchema,
  eventTypes: z.array(webhookEventTypeSchema).min(1),
  targetId: uuidV4Schema.nullish(),
  enabled: z.boolean().optional()
}).strict();

export const updateWebhookSubscriptionSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  url: webhookUrlSchema.optional(),
  eventTypes: z.array(webhookEventTypeSchema).min(1).optional(),
  targetId: uuidV4Schema.nullable().optional(),
  enabled: z.boolean().optional()
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: 'at least one field is required'
});

export type RunRequest = z.infer<typeof runRequestSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventsBatch = z.infer<typeof runEventsBatchSchema>;
export type RunCommit = z.infer<typeof runCommitSchema>;
export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>;
