import { accessSync, constants } from 'node:fs';
import { z } from 'zod';

function addFileIssue(ctx: z.RefinementCtx, field: string, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
}

export function requireReadableFile(ctx: z.RefinementCtx, field: string, value: string | undefined): void {
  if (!value) {
    addFileIssue(ctx, field, `${field} is required when internal transport TLS is enabled`);
    return;
  }
  try {
    accessSync(value, constants.R_OK);
  } catch {
    addFileIssue(ctx, field, `${field} must point to a readable file when internal transport TLS is enabled`);
  }
}

export function validateOptionalReadableFile(
  ctx: z.RefinementCtx,
  field: string,
  value: string | undefined
): void {
  if (!value) return;
  try {
    accessSync(value, constants.R_OK);
  } catch {
    addFileIssue(ctx, field, `${field} must point to a readable file`);
  }
}
