import { z } from 'zod';
import { TARGET_TYPES } from './domain.js';

export const internalMcpToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.unknown()).optional().default({}),
  toolCallId: z.string().min(1).max(256).optional(),
  targetId: z.string().min(1).optional(),
  targetType: z.enum(TARGET_TYPES).optional(),
  toolRef: z.object({ server_id: z.string().min(1), tool_name: z.string().min(1) }).strict().optional()
}).superRefine((value, ctx) => {
  if (Boolean(value.targetId) !== Boolean(value.targetType)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'targetId and targetType must be provided together' });
  }
});
