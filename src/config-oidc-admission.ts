import { z } from 'zod';

const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'URL must use http or https');

export const oidcHttpUrlFromEnv = httpUrlSchema;
export const optionalOidcHttpUrlFromEnv = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  httpUrlSchema.optional()
);
export const oidcScopesFromEnv = z.string().refine(
  (value) => value.split(/\s+/).includes('openid'),
  'OIDC_SCOPES must include openid'
);

const unsafeClaimPathSegments = new Set(['__proto__', 'prototype', 'constructor']);
const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const claimPathSchema = z.array(z.string().trim().min(1)).min(1).max(16).superRefine((path, ctx) => {
  path.forEach((segment, index) => {
    if (unsafeClaimPathSegments.has(segment)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: `Unsafe claim path segment: ${segment}`
      });
    }
  });
});

const existsRuleSchema = z.object({
  path: claimPathSchema,
  operator: z.literal('exists')
}).strict();

const equalsRuleSchema = z.object({
  path: claimPathSchema,
  operator: z.literal('equals'),
  value: scalarSchema
}).strict();

const containsRuleSchema = z.object({
  path: claimPathSchema,
  operator: z.literal('contains'),
  value: scalarSchema
}).strict();

const intersectsRuleSchema = z.object({
  path: claimPathSchema,
  operator: z.literal('intersects'),
  values: z.array(scalarSchema).min(1).max(100)
}).strict().superRefine((rule, ctx) => {
  const valueType = typeof rule.values[0];
  if (rule.values.some((value) => typeof value !== valueType)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['values'],
      message: 'intersects values must all have the same scalar type'
    });
  }
});

export const oidcAdmissionPolicySchema = z.object({
  requireVerifiedEmail: z.boolean().optional(),
  allowedEmailDomains: z.array(
    z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/)
  ).max(100).optional(),
  requiredClaims: z.array(z.union([
    existsRuleSchema,
    equalsRuleSchema,
    containsRuleSchema,
    intersectsRuleSchema
  ])).max(100).optional()
}).strict();

export type OidcAdmissionPolicy = z.infer<typeof oidcAdmissionPolicySchema>;
export type OidcAdmissionClaimRule = NonNullable<OidcAdmissionPolicy['requiredClaims']>[number];

export function parseOidcAdmissionPolicy(raw: string | undefined): OidcAdmissionPolicy {
  let parsed: unknown = {};
  if (raw?.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('OIDC_ADMISSION_POLICY_JSON must contain valid JSON');
    }
  }
  const result = oidcAdmissionPolicySchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'policy'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid OIDC admission policy: ${detail}`);
  }
  return result.data;
}

export const oidcAdmissionPolicyFromEnv = z.string().default('{}').transform((raw, ctx) => {
  try {
    return parseOidcAdmissionPolicy(raw);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : 'Invalid OIDC admission policy'
    });
    return z.NEVER;
  }
});

export function oidcAdmissionPolicyIsEmpty(policy: OidcAdmissionPolicy): boolean {
  return policy.requireVerifiedEmail === undefined
    && !policy.allowedEmailDomains?.length
    && !policy.requiredClaims?.length;
}

interface OidcAuthenticationConfig {
  OIDC_ENABLED: boolean;
  PASSWORD_AUTH_ENABLED: boolean;
  OIDC_ADMISSION_POLICY_JSON: OidcAdmissionPolicy;
  OIDC_END_SESSION_ENDPOINT_OVERRIDE?: string;
  OIDC_POST_LOGOUT_REDIRECT_URI?: string;
}

function addConfigIssue(ctx: z.RefinementCtx, field: string, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
}

export function validateOidcAuthenticationConfig(
  ctx: z.RefinementCtx,
  value: OidcAuthenticationConfig
): void {
  if (!value.OIDC_ENABLED && !value.PASSWORD_AUTH_ENABLED) {
    addConfigIssue(ctx, 'OIDC_ENABLED', 'At least one of OIDC_ENABLED or PASSWORD_AUTH_ENABLED must be enabled');
  }
  if (!value.OIDC_ENABLED && !oidcAdmissionPolicyIsEmpty(value.OIDC_ADMISSION_POLICY_JSON)) {
    addConfigIssue(ctx, 'OIDC_ADMISSION_POLICY_JSON', 'OIDC admission policy is not allowed when OIDC_ENABLED is false');
  }
  if (!value.OIDC_ENABLED && (value.OIDC_END_SESSION_ENDPOINT_OVERRIDE || value.OIDC_POST_LOGOUT_REDIRECT_URI)) {
    addConfigIssue(ctx, 'OIDC_ENABLED', 'OIDC logout configuration is not allowed when OIDC_ENABLED is false');
  }
}

interface FinalizableOidcConfig {
  MANAGEMENT_CONSOLE_BASE_URL: string;
  OIDC_ADMISSION_POLICY_JSON: OidcAdmissionPolicy;
  OIDC_POST_LOGOUT_REDIRECT_URI?: string;
}

export function finalizeOidcConfig<T extends FinalizableOidcConfig>(value: T):
  Omit<T, 'OIDC_ADMISSION_POLICY_JSON' | 'OIDC_POST_LOGOUT_REDIRECT_URI'> & {
    OIDC_ADMISSION_POLICY: OidcAdmissionPolicy;
    OIDC_POST_LOGOUT_REDIRECT_URI: string;
  } {
  const { OIDC_ADMISSION_POLICY_JSON: policy, OIDC_POST_LOGOUT_REDIRECT_URI: redirectUri, ...rest } = value;
  return {
    ...rest,
    OIDC_ADMISSION_POLICY: policy,
    OIDC_POST_LOGOUT_REDIRECT_URI: redirectUri
      || `${value.MANAGEMENT_CONSOLE_BASE_URL.replace(/\/$/, '')}/api/v1/auth/oidc/logout/callback`
  };
}
