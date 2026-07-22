import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { OidcAdmissionClaimRule, OidcAdmissionPolicy } from '../config-oidc-admission.js';

type Claims = Record<string, unknown>;
const emailSchema = z.string().email();

export type OidcAdmissionReason =
  | 'allowed'
  | 'email_missing'
  | 'email_invalid'
  | 'email_domain_denied'
  | 'email_unverified'
  | 'required_claim_missing'
  | 'required_claim_conflict'
  | 'required_claim_mismatch';

export type OidcAdmissionDecision =
  | { allowed: true; reason: 'allowed' }
  | { allowed: false; reason: Exclude<OidcAdmissionReason, 'allowed'> };

type ResolvedClaim =
  | { status: 'missing' }
  | { status: 'conflict' }
  | { status: 'resolved'; value: unknown };

function claimAtPath(claims: Claims, path: string[]): { found: boolean; value?: unknown } {
  let current: unknown = claims;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = (current as Claims)[segment];
  }
  return { found: true, value: current };
}

function resolveClaim(idTokenClaims: Claims, userInfoClaims: Claims, path: string[]): ResolvedClaim {
  const idTokenValue = claimAtPath(idTokenClaims, path);
  const userInfoValue = claimAtPath(userInfoClaims, path);
  if (!idTokenValue.found && !userInfoValue.found) return { status: 'missing' };
  if (idTokenValue.found && userInfoValue.found) {
    return isDeepStrictEqual(idTokenValue.value, userInfoValue.value)
      ? { status: 'resolved', value: idTokenValue.value }
      : { status: 'conflict' };
  }
  return { status: 'resolved', value: idTokenValue.found ? idTokenValue.value : userInfoValue.value };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function scalarEquals(left: unknown, right: string | number | boolean): boolean {
  return isScalar(left) && typeof left === typeof right && left === right;
}

function ruleMatches(rule: OidcAdmissionClaimRule, value: unknown): boolean {
  if (rule.operator === 'exists') return value !== null && value !== undefined;
  if (rule.operator === 'equals') return scalarEquals(value, rule.value);
  const values = Array.isArray(value) ? value : [value];
  if (rule.operator === 'contains') return values.some((item) => scalarEquals(item, rule.value));
  return values.some((item) => rule.values.some((candidate) => scalarEquals(item, candidate)));
}

function deny(reason: Exclude<OidcAdmissionReason, 'allowed'>): OidcAdmissionDecision {
  return { allowed: false, reason };
}

export function evaluateOidcAdmission(input: {
  policy: OidcAdmissionPolicy;
  idTokenClaims: Claims;
  userInfoClaims: Claims;
}): OidcAdmissionDecision {
  const { policy, idTokenClaims, userInfoClaims } = input;
  if (policy.requireVerifiedEmail === true) {
    const verified = resolveClaim(idTokenClaims, userInfoClaims, ['email_verified']);
    if (verified.status === 'conflict') return deny('required_claim_conflict');
    if (verified.status !== 'resolved' || verified.value !== true) return deny('email_unverified');
  }

  if (policy.allowedEmailDomains?.length) {
    const email = resolveClaim(idTokenClaims, userInfoClaims, ['email']);
    if (email.status === 'conflict') return deny('required_claim_conflict');
    if (email.status !== 'resolved' || typeof email.value !== 'string') return deny('email_missing');
    const normalized = email.value.trim().toLowerCase();
    if (!emailSchema.safeParse(normalized).success) return deny('email_invalid');
    const separator = normalized.lastIndexOf('@');
    if (!policy.allowedEmailDomains.includes(normalized.slice(separator + 1))) return deny('email_domain_denied');
  }

  for (const rule of policy.requiredClaims || []) {
    const claim = resolveClaim(idTokenClaims, userInfoClaims, rule.path);
    if (claim.status === 'missing') return deny('required_claim_missing');
    if (claim.status === 'conflict') return deny('required_claim_conflict');
    if (!ruleMatches(rule, claim.value)) return deny('required_claim_mismatch');
  }
  return { allowed: true, reason: 'allowed' };
}
