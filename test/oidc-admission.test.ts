import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateOidcAdmission } from '../src/auth/oidc-admission.js';
import { parseOidcAdmissionPolicy } from '../src/config-oidc-admission.js';

describe('OIDC admission policy', () => {
  it('allows valid identities when the policy is omitted', () => {
    assert.deepEqual(evaluateOidcAdmission({
      policy: parseOidcAdmissionPolicy(undefined),
      idTokenClaims: { sub: 'subject-1' },
      userInfoClaims: {}
    }), { allowed: true, reason: 'allowed' });
  });

  it('requires a literal verified-email boolean and exact case-insensitive domain', () => {
    const policy = parseOidcAdmissionPolicy(JSON.stringify({
      requireVerifiedEmail: true,
      allowedEmailDomains: ['Example.COM']
    }));
    assert.equal(evaluateOidcAdmission({
      policy,
      idTokenClaims: { email: 'Alice@EXAMPLE.com', email_verified: true },
      userInfoClaims: {}
    }).allowed, true);
    assert.deepEqual(evaluateOidcAdmission({
      policy,
      idTokenClaims: { email: 'alice@sub.example.com', email_verified: true },
      userInfoClaims: {}
    }), { allowed: false, reason: 'email_domain_denied' });
    assert.deepEqual(evaluateOidcAdmission({
      policy,
      idTokenClaims: { email: 'not valid@example.com', email_verified: true },
      userInfoClaims: {}
    }), { allowed: false, reason: 'email_invalid' });
    assert.deepEqual(evaluateOidcAdmission({
      policy,
      idTokenClaims: { email: 'alice@example.com', email_verified: 'true' },
      userInfoClaims: {}
    }), { allowed: false, reason: 'email_unverified' });
  });

  it('supports strict claim operators and literal-dot path segments', () => {
    const policy = parseOidcAdmissionPolicy(JSON.stringify({
      requiredClaims: [
        { path: ['profile', 'active'], operator: 'equals', value: true },
        { path: ['groups'], operator: 'contains', value: 'platform' },
        { path: ['roles'], operator: 'intersects', values: ['admin', 'operator'] },
        { path: ['https://acornops.dev/claims.team'], operator: 'exists' }
      ]
    }));
    assert.equal(evaluateOidcAdmission({
      policy,
      idTokenClaims: {
        profile: { active: true },
        groups: ['platform', 'engineering'],
        roles: 'operator',
        'https://acornops.dev/claims.team': 'sre'
      },
      userInfoClaims: {}
    }).allowed, true);
    assert.deepEqual(evaluateOidcAdmission({
      policy,
      idTokenClaims: {
        profile: { active: 1 },
        groups: ['platform'],
        roles: ['operator'],
        'https://acornops.dev/claims.team': 'sre'
      },
      userInfoClaims: {}
    }), { allowed: false, reason: 'required_claim_mismatch' });
  });

  it('fails closed on conflicts between verified claim sources', () => {
    const policy = parseOidcAdmissionPolicy(JSON.stringify({
      requiredClaims: [{ path: ['groups'], operator: 'contains', value: 'platform' }]
    }));
    assert.deepEqual(evaluateOidcAdmission({
      policy,
      idTokenClaims: { groups: ['platform'] },
      userInfoClaims: { groups: ['other'] }
    }), { allowed: false, reason: 'required_claim_conflict' });
  });

  it('rejects unsafe paths, mixed intersects values, and unknown fields', () => {
    assert.throws(() => parseOidcAdmissionPolicy(JSON.stringify({
      requiredClaims: [{ path: ['__proto__'], operator: 'exists' }]
    })), /Unsafe claim path segment/);
    assert.throws(() => parseOidcAdmissionPolicy(JSON.stringify({
      requiredClaims: [{ path: ['groups'], operator: 'intersects', values: ['admin', 1] }]
    })), /same scalar type/);
    assert.throws(() => parseOidcAdmissionPolicy(JSON.stringify({ allowEveryone: true })), /Unrecognized key/);
  });
});
