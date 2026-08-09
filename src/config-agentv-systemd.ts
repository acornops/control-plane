import { z } from 'zod';

export const DEFAULT_AGENTV_SYSTEMD_RELEASE_BASE_URL = 'https://github.com/acornops/agentv/releases/download';
export const DEVELOPMENT_AGENTV_SYSTEMD_RELEASE_VERSION = '0.0.1-experimental.6';

function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

export const agentVSystemdConfigFields = {
  AGENTV_SYSTEMD_RELEASE_VERSION: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
  AGENTV_SYSTEMD_RELEASE_BASE_URL: z.preprocess(
    emptyStringToUndefined,
    z.string().url().default(DEFAULT_AGENTV_SYSTEMD_RELEASE_BASE_URL)
  )
};

const exactSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateAgentVSystemdConfig(
  ctx: z.RefinementCtx,
  value: {
    NODE_ENV: 'development' | 'test' | 'production';
    CONTROL_PLANE_BASE_URL: string;
    AGENTV_SYSTEMD_RELEASE_VERSION?: string;
    AGENTV_SYSTEMD_RELEASE_BASE_URL: string;
  }
): void {
  const version = value.AGENTV_SYSTEMD_RELEASE_VERSION;
  if (!version && value.NODE_ENV === 'production') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENTV_SYSTEMD_RELEASE_VERSION'],
      message: 'AGENTV_SYSTEMD_RELEASE_VERSION must pin an exact AgentV version in production'
    });
  } else if (version && !exactSemverPattern.test(version)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENTV_SYSTEMD_RELEASE_VERSION'],
      message: 'AGENTV_SYSTEMD_RELEASE_VERSION must be an exact semantic version'
    });
  }

  const releaseUrl = new URL(value.AGENTV_SYSTEMD_RELEASE_BASE_URL);
  if (releaseUrl.username || releaseUrl.password || releaseUrl.search || releaseUrl.hash
    || value.AGENTV_SYSTEMD_RELEASE_BASE_URL.includes("'")
    || value.AGENTV_SYSTEMD_RELEASE_BASE_URL.includes('\\')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENTV_SYSTEMD_RELEASE_BASE_URL'],
      message: 'AGENTV_SYSTEMD_RELEASE_BASE_URL must not contain credentials, a query, a fragment, quotes, or backslashes'
    });
  }
  if (value.NODE_ENV === 'production' && releaseUrl.protocol !== 'https:') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENTV_SYSTEMD_RELEASE_BASE_URL'],
      message: 'AGENTV_SYSTEMD_RELEASE_BASE_URL must use HTTPS in production'
    });
  }

  if (value.NODE_ENV === 'production') {
    const platformUrl = new URL(value.CONTROL_PLANE_BASE_URL);
    if (platformUrl.username || platformUrl.password || platformUrl.search || platformUrl.hash
      || value.CONTROL_PLANE_BASE_URL.includes("'") || value.CONTROL_PLANE_BASE_URL.includes('\\')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CONTROL_PLANE_BASE_URL'],
        message: 'CONTROL_PLANE_BASE_URL must not contain credentials, a query, a fragment, quotes, or backslashes'
      });
    }
  }
}

export function normalizeAgentVSystemdConfig(value: {
  AGENTV_SYSTEMD_RELEASE_VERSION?: string;
  AGENTV_SYSTEMD_RELEASE_BASE_URL: string;
}): { AGENTV_SYSTEMD_RELEASE_VERSION: string; AGENTV_SYSTEMD_RELEASE_BASE_URL: string } {
  return {
    AGENTV_SYSTEMD_RELEASE_VERSION: value.AGENTV_SYSTEMD_RELEASE_VERSION ?? DEVELOPMENT_AGENTV_SYSTEMD_RELEASE_VERSION,
    AGENTV_SYSTEMD_RELEASE_BASE_URL: value.AGENTV_SYSTEMD_RELEASE_BASE_URL.replace(/\/+$/, '')
  };
}
