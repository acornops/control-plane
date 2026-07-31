import { z } from 'zod';

const adminReasonSchema = z.string().trim().min(3).max(500);
const availabilityValues = ['agents', 'kubernetes', 'virtual_machines'] as const;
const availabilityOrder = new Map(availabilityValues.map((value, index) => [value, index]));
const availabilitySchema = z.array(z.enum(availabilityValues)).min(1).max(3)
  .superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Available in destinations must be unique' });
    }
  })
  .transform((values) => [...values].sort((left, right) =>
    (availabilityOrder.get(left) || 0) - (availabilityOrder.get(right) || 0)));
const skillFileSchema = z.object({
  path: z.string().trim().min(1).max(512),
  content: z.string().max(32768)
}).strict();
const skillSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('manual')
  }).strict(),
  z.object({
    type: z.literal('git'),
    provider: z.enum(['github', 'gitlab']),
    repoUrl: z.string().url().max(2048),
    ref: z.string().trim().min(1).max(255),
    subpath: z.string().trim().min(1).max(512).optional(),
    commitSha: z.string().trim().regex(/^[0-9a-f]{40}$/i)
  }).strict()
]);
export const adminWorkspaceDefaultCreateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mcp_server'),
    name: z.string().trim().min(1).max(200),
    availableIn: availabilitySchema,
    source: z.object({ type: z.literal('https'), endpoint: z.string().url().max(2048) }).strict(),
    reason: adminReasonSchema
  }).strict(),
  z.object({
    kind: z.literal('skill'),
    availableIn: availabilitySchema,
    source: skillSourceSchema,
    files: z.array(skillFileSchema).min(1).max(16),
    reason: adminReasonSchema
  }).strict()
]);
export const adminWorkspaceDefaultPatchSchema = z.object({
  availableIn: availabilitySchema.optional(),
  enabled: z.boolean().optional(),
  reason: adminReasonSchema
}).strict().superRefine((value, ctx) => {
  if (value.availableIn === undefined && value.enabled === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one of availableIn or enabled must be provided'
    });
  }
});
export const adminWorkspaceDefaultDeleteSchema = z.object({
  reason: adminReasonSchema
}).strict();
