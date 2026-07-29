import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ZodError } from 'zod';

const webhookKey = Buffer.alloc(32, 7).toString('base64');
const gatewaySigningKeyPem = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicExponent: 0x10001
}).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

export function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    CONTROL_PLANE_BASE_URL: 'https://ops.example.com',
    MANAGEMENT_CONSOLE_BASE_URL: 'https://console.example.com',
    CORS_ORIGIN: 'https://ops.example.com',
    OIDC_ISSUER_URL: 'https://id.example.com/realms/acornops',
    OIDC_PUBLIC_ISSUER_URL: 'https://id.example.com/realms/acornops',
    OIDC_CLIENT_SECRET: 'cp_oidc_secret_0123456789abcdef012345',
    CSRF_SECRET: 'csrf_secret_0123456789abcdef0123456789',
    OIDC_REDIRECT_URI: 'https://ops.example.com/api/v1/auth/oidc/callback',
    ORCH_SERVICE_TOKEN: 'orch_service_token_0123456789abcdef012345',
    EXTERNAL_INTEGRATION_CLIENTS_JSON: JSON.stringify([{
      id: 'mattermost-bot',
      provider: 'mattermost',
      displayName: 'Mattermost Bot',
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    }]),
    EXECUTION_ENGINE_DISPATCH_TOKEN: 'dispatch_token_0123456789abcdef012345',
    EMAIL_DELIVERY_MODE: 'smtp',
    EMAIL_PUBLIC_BASE_URL: 'https://ops.example.com',
    SMTP_HOST: 'smtp.example.com',
    SMTP_USERNAME: 'apikey',
    SMTP_PASSWORD: 'smtp_password_0123456789',
    DATABASE_URL: 'postgresql://acornops:cp_db_password_0123456789@cp-postgres:5432/acornops_control_plane',
    LLM_GATEWAY_ADMIN_TOKEN: 'gateway_admin_token_0123456789abcdef',
    GATEWAY_SIGNING_PRIVATE_KEY_PEM_B64: Buffer.from(gatewaySigningKeyPem).toString('base64'),
    WEBHOOK_SECRET_ENCRYPTION_KEY: webhookKey,
    SEED_DEVELOPMENT_DATA: 'false',
    ...overrides
  };
}

export function fieldErrors(error: unknown): Record<string, string[] | undefined> {
  assert.ok(error instanceof ZodError);
  return error.flatten().fieldErrors;
}
