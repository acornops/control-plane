import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { parseAppConfig } from '../src/config.js';

function fieldErrors(error: unknown): Record<string, string[] | undefined> {
  assert.ok(error instanceof ZodError);
  return error.flatten().fieldErrors;
}

describe('OIDC configuration', () => {
  it('rejects the removed verified-email setting instead of silently weakening admission', () => {
    assert.throws(
      () => parseAppConfig({ NODE_ENV: 'test', OIDC_REQUIRE_VERIFIED_EMAIL: 'true' }),
      (error) => Boolean(fieldErrors(error).OIDC_REQUIRE_VERIFIED_EMAIL?.length)
    );
  });

  it('rejects non-HTTP endpoints and scope sets without openid', () => {
    assert.throws(
      () => parseAppConfig({ NODE_ENV: 'test', OIDC_TOKEN_ENDPOINT_OVERRIDE: 'ftp://identity.example.com/token' }),
      (error) => Boolean(fieldErrors(error).OIDC_TOKEN_ENDPOINT_OVERRIDE?.length)
    );
    assert.throws(
      () => parseAppConfig({ NODE_ENV: 'test', OIDC_SCOPES: 'profile email' }),
      (error) => Boolean(fieldErrors(error).OIDC_SCOPES?.length)
    );
  });

  it('requires at least one browser authentication method', () => {
    assert.throws(
      () => parseAppConfig({ NODE_ENV: 'test', OIDC_ENABLED: 'false', PASSWORD_AUTH_ENABLED: 'false' }),
      (error) => Boolean(fieldErrors(error).OIDC_ENABLED?.length)
    );
  });

  it('rejects admission configuration when OIDC is disabled', () => {
    assert.throws(
      () => parseAppConfig({
        NODE_ENV: 'test',
        OIDC_ENABLED: 'false',
        PASSWORD_AUTH_ENABLED: 'true',
        OIDC_ADMISSION_POLICY_JSON: JSON.stringify({ requireVerifiedEmail: true })
      }),
      (error) => Boolean(fieldErrors(error).OIDC_ADMISSION_POLICY_JSON?.length)
    );
  });

  it('rejects logout configuration when OIDC is disabled', () => {
    assert.throws(
      () => parseAppConfig({
        NODE_ENV: 'test',
        OIDC_ENABLED: 'false',
        PASSWORD_AUTH_ENABLED: 'true',
        OIDC_END_SESSION_ENDPOINT_OVERRIDE: 'https://identity.example.com/logout'
      }),
      (error) => Boolean(fieldErrors(error).OIDC_ENABLED?.length)
    );
  });

  it('requires an HTTPS browser-facing logout endpoint in production', () => {
    assert.throws(
      () => parseAppConfig({
        NODE_ENV: 'production',
        CONTROL_PLANE_BASE_URL: 'https://api.example.com',
        MANAGEMENT_CONSOLE_BASE_URL: 'https://console.example.com',
        CORS_ORIGIN: 'https://console.example.com',
        OIDC_ISSUER_URL: 'https://identity.example.com/realms/acornops',
        OIDC_PUBLIC_ISSUER_URL: 'https://identity.example.com/realms/acornops',
        OIDC_REDIRECT_URI: 'https://console.example.com/api/v1/auth/oidc/callback',
        OIDC_END_SESSION_ENDPOINT_OVERRIDE: 'http://identity.example.com/logout'
      }),
      (error) => Boolean(fieldErrors(error).OIDC_END_SESSION_ENDPOINT_OVERRIDE?.length)
    );
  });
});
