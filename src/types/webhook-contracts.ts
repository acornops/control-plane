import { z } from 'zod';

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidV4Schema = z.string().regex(uuidV4Pattern, 'must be a UUIDv4');

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
  'issue.created.v1',
  'issue.reopened.v1',
  'issue.resolved.v1',
  'tool.called.v1',
  'mcp.server.created.v1',
  'mcp.server.updated.v1',
  'mcp.server.deleted.v1',
  'mcp.server.tested.v1',
  'tool.catalog.changed.v1'
] as const;

export const webhookEventTypeSchema = z.enum(webhookEventTypes);

export const webhookUrlSchema = z.string().url().refine(
  (value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  },
  { message: 'webhook URL must use https and must not include credentials' }
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

export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>;
