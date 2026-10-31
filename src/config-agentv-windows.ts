import { z } from 'zod';

export function isSafeWindowsInstallUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && !/[\s'"`\\\x00-\x1f\x7f\u2018-\u201f]/.test(value);
  } catch { return false; }
}

export const windowsAgentVConfigFields = {
  AGENTV_WINDOWS_ENABLED: z.preprocess((value) => {
    if (value === undefined || value === '') return false;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }, z.boolean()),
  AGENTV_WINDOWS_RELEASE_VERSION: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/).optional(),
  AGENTV_WINDOWS_RELEASE_BASE_URL: z.string().refine(isSafeWindowsInstallUrl, 'must be a literal HTTPS release URL').optional()
};

export function validateWindowsAgentVConfig(ctx: z.RefinementCtx, value: {
  AGENTV_WINDOWS_ENABLED: boolean; AGENTV_WINDOWS_RELEASE_VERSION?: string; AGENTV_WINDOWS_RELEASE_BASE_URL?: string;
}): void {
  if (value.AGENTV_WINDOWS_ENABLED && (!value.AGENTV_WINDOWS_RELEASE_VERSION || !value.AGENTV_WINDOWS_RELEASE_BASE_URL)) {
    ctx.addIssue({ code: 'custom', path: ['AGENTV_WINDOWS_ENABLED'], message: 'Windows rollout requires independently pinned release version and HTTPS base URL' });
  }
}

export const windowsAgentVConfigSchema = z.object(windowsAgentVConfigFields)
  .superRefine((value, ctx) => validateWindowsAgentVConfig(ctx, value));
