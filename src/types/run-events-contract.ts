import { z } from 'zod';

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidV4Schema = z.string().regex(uuidV4Pattern, 'must be a UUIDv4');
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const MAX_MODEL_CONTEXT_BYTES = 12 * 1024;

const toolCallCompletedPayloadSchema = z.object({
  call_id: z.string().min(1).max(256),
  tool: z.string().min(1).max(128),
  result: z.unknown(),
  context_meta: z.object({
    schema_version: z.literal('v1'),
    strategy: z.string().min(1).max(64),
    original_bytes: z.number().int().nonnegative(),
    context_bytes: z.number().int().nonnegative().max(MAX_MODEL_CONTEXT_BYTES),
    truncated: z.boolean(),
    omissions: z.array(z.unknown())
  }).strict(),
  artifact: z.object({
    id: uuidV4Schema,
    expires_at: z.string().datetime(),
    sha256: sha256Schema,
    uncompressed_bytes: z.number().int().nonnegative().max(2 * 1024 * 1024),
    compressed_bytes: z.number().int().nonnegative(),
    content_type: z.enum(['application/json', 'text/plain'])
  }).strict().optional(),
  artifactUnavailable: z.literal(true).optional(),
  is_error: z.boolean()
}).strict().superRefine((payload, ctx) => {
  if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'result is required' });
    return;
  }
  const serialized = JSON.stringify(payload.result);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_MODEL_CONTEXT_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['result'],
      message: 'model context exceeds the 12 KiB event limit'
    });
  }
});

export const runEventSchema = z.object({
  schema_version: z.literal(1),
  run_id: uuidV4Schema,
  seq: z.number().int().positive(),
  ts: z.string().datetime(),
  type: z.string().min(1),
  payload: z.record(z.unknown())
}).superRefine((event, ctx) => {
  if (event.type !== 'tool_call_completed') return;
  const parsed = toolCallCompletedPayloadSchema.safeParse(event.payload);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payload', ...issue.path],
      message: issue.message
    });
  }
});

export const runEventsBatchSchema = z.object({
  events: z.array(runEventSchema)
});
