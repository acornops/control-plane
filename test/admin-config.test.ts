import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { parseAppConfig } from '../src/config.js';

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const baseProductionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'production', CONTROL_PLANE_BASE_URL: 'https://ops.example.com', MANAGEMENT_CONSOLE_BASE_URL: 'https://console.example.com',
  CORS_ORIGIN: 'https://ops.example.com', OIDC_ISSUER_URL: 'https://id.example.com/realms/acornops', OIDC_PUBLIC_ISSUER_URL: 'https://id.example.com/realms/acornops',
  OIDC_CLIENT_SECRET: 'cp_oidc_secret_0123456789abcdef012345', CSRF_SECRET: 'csrf_secret_0123456789abcdef0123456789', OIDC_REDIRECT_URI: 'https://ops.example.com/api/v1/auth/oidc/callback',
  ORCH_SERVICE_TOKEN: 'orch_service_token_0123456789abcdef012345', EXECUTION_ENGINE_DISPATCH_TOKEN: 'dispatch_token_0123456789abcdef012345',
  EXTERNAL_INTEGRATION_CLIENTS_JSON: JSON.stringify([{ id: 'mattermost-bot', provider: 'mattermost', displayName: 'Mattermost Bot', sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }]),
  EMAIL_DELIVERY_MODE: 'smtp', EMAIL_PUBLIC_BASE_URL: 'https://ops.example.com', SMTP_HOST: 'smtp.example.com', SMTP_USERNAME: 'apikey', SMTP_PASSWORD: 'smtp_password_0123456789',
  DATABASE_URL: 'postgresql://acornops:cp_db_password_0123456789@cp-postgres:5432/acornops_control_plane', LLM_GATEWAY_ADMIN_TOKEN: 'gateway_admin_token_0123456789abcdef',
  GATEWAY_SIGNING_PRIVATE_KEY_PEM_B64: Buffer.from(signingKey).toString('base64'), WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), SEED_DEVELOPMENT_DATA: 'false'
};
const validAdmin = {
  CONTROL_PLANE_ADMIN_API_ENABLED: 'true', CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED: 'true',
  CONTROL_PLANE_ADMIN_TOKENS_JSON: JSON.stringify([{ id: 'platform-admin-console', sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', scopes: ['admin:self', 'admin:workspace:read'], enabled: true }]),
  PLATFORM_ADMIN_CONSOLE_BASE_URL: 'https://admin.acornops.dev', ADMIN_OIDC_ISSUER_URL: 'https://id.example.com/realms/acornops', ADMIN_OIDC_PUBLIC_ISSUER_URL: 'https://id.example.com/realms/acornops',
  ADMIN_OIDC_CLIENT_SECRET: 'admin_oidc_secret_0123456789abcdef012345', ADMIN_CSRF_SECRET: 'admin_csrf_secret_0123456789abcdef012345', ADMIN_OIDC_REDIRECT_URI: 'https://admin.acornops.dev/admin-auth/oidc/callback'
};

function hasField(error: unknown, field: string): boolean { return error instanceof ZodError && Boolean(error.flatten().fieldErrors[field]?.length); }

describe('production platform admin configuration', () => {
  it('leaves token-only operational admin deployments unchanged when platform-admin human auth is disabled', () => {
    const config = parseAppConfig({
      ...baseProductionEnv,
      CONTROL_PLANE_ADMIN_API_ENABLED: 'true',
      CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED: 'false',
      CONTROL_PLANE_ADMIN_TOKENS_JSON: JSON.stringify([{
        id: 'ops-primary',
        sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        scopes: ['admin:target:read'],
        enabled: true
      }])
    });
    assert.equal(config.CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED, false);
  });

  it('requires the exact identity roles, host cookies, and callback origin', () => {
    const parse = (overrides: NodeJS.ProcessEnv = {}) => parseAppConfig({ ...baseProductionEnv, ...validAdmin, ...overrides });
    assert.equal(parse().ADMIN_OIDC_ALLOWED_ROLES, 'platform-admin,platform-admin-viewer,platform-admin-auditor');
    assert.throws(() => parse({ ADMIN_OIDC_ALLOWED_ROLES: 'platform-admin,workspace-owner' }), (error) => hasField(error, 'ADMIN_OIDC_ALLOWED_ROLES'));
    assert.throws(() => parse({ PLATFORM_ADMIN_BFF_TOKEN_ID: 'missing-bff-token' }), (error) => hasField(error, 'PLATFORM_ADMIN_BFF_TOKEN_ID'));
    assert.throws(() => parse({ ADMIN_SESSION_COOKIE_NAME: 'admin_session' }), (error) => hasField(error, 'ADMIN_SESSION_COOKIE_NAME'));
    assert.throws(() => parse({ ADMIN_OIDC_REDIRECT_URI: 'https://ops.example.com/admin-auth/oidc/callback' }), (error) => hasField(error, 'ADMIN_OIDC_REDIRECT_URI'));
  });
});
