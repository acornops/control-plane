import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { parseAllowedOrigins } from '../src/auth/origins.js';
import { parseAppConfig } from '../src/config.js';

const webhookKey = Buffer.alloc(32, 7).toString('base64');
const gatewaySigningKeyPem = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicExponent: 0x10001
}).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
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

function fieldErrors(error: unknown): Record<string, string[] | undefined> {
  assert.ok(error instanceof ZodError);
  return error.flatten().fieldErrors;
}

describe('parseAppConfig production validation', () => {
  it('accepts generated production secrets and browser-facing https URLs', () => {
    const config = parseAppConfig(productionEnv());

    assert.equal(config.NODE_ENV, 'production');
    assert.equal(config.PERSIST_RUN_EVENTS, true);
    assert.equal(config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED, true);
    assert.equal(config.AGENT_WS_REQUIRE_SECURE_TRANSPORT, true);
    assert.equal(config.PASSWORD_AUTH_ENABLED, true);
  });

  it('accepts cluster-local OIDC issuer URLs when a public issuer is configured', () => {
    const config = parseAppConfig(productionEnv({
      OIDC_ISSUER_URL: 'http://acornops-keycloak.acornops-identity.svc.cluster.local/realms/acornops',
      OIDC_PUBLIC_ISSUER_URL: 'https://identity.demo.acornops.dev/realms/acornops',
      OIDC_TOKEN_ENDPOINT_OVERRIDE: 'http://acornops-keycloak.acornops-identity.svc.cluster.local/realms/acornops/protocol/openid-connect/token',
      OIDC_USERINFO_ENDPOINT_OVERRIDE: 'http://acornops-keycloak.acornops-identity.svc.cluster.local/realms/acornops/protocol/openid-connect/userinfo',
      OIDC_JWKS_URI_OVERRIDE: 'http://acornops-keycloak.acornops-identity.svc.cluster.local/realms/acornops/protocol/openid-connect/certs'
    }));

    assert.equal(config.OIDC_ISSUER_URL, 'http://acornops-keycloak.acornops-identity.svc.cluster.local/realms/acornops');
    assert.equal(config.OIDC_PUBLIC_ISSUER_URL, 'https://identity.demo.acornops.dev/realms/acornops');
  });

  it('requires a public issuer for production cluster-local OIDC issuer URLs', () => {
    assert.throws(
      () =>
        parseAppConfig(productionEnv({
          OIDC_ISSUER_URL: 'http://acornops-keycloak.acornops-identity.svc.cluster.local/realms/acornops',
          OIDC_PUBLIC_ISSUER_URL: ''
        })),
      (error) => Boolean(fieldErrors(error).OIDC_PUBLIC_ISSUER_URL?.length)
    );
  });

  it('rejects placeholder production secrets and unsafe URLs', () => {
    assert.throws(
      () =>
        parseAppConfig(
          productionEnv({
            CONTROL_PLANE_BASE_URL: 'http://localhost:8081',
            CORS_ORIGIN: '*',
            OIDC_CLIENT_SECRET: 'replace-me',
            CSRF_SECRET: 'dev_csrf_secret_change_me_32_bytes_minimum',
            ORCH_SERVICE_TOKEN: 'dev_orchestrator_token',
            EXTERNAL_INTEGRATION_CLIENTS_JSON: JSON.stringify([{
              id: 'example-client',
              provider: 'example',
              displayName: 'Example client',
              sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
            }]),
            EXECUTION_ENGINE_DISPATCH_TOKEN: 'change-me',
            DATABASE_URL: 'postgresql://acornops:acornops@cp-postgres:5432/acornops_control_plane',
            LLM_GATEWAY_ADMIN_TOKEN: 'replace-me',
            GATEWAY_SIGNING_PRIVATE_KEY_PEM_B64: 'change-me',
            WEBHOOK_SECRET_ENCRYPTION_KEY: 'replace-me-with-32-byte-base64',
            SEED_DEVELOPMENT_DATA: 'true'
          })
        ),
      (error) => {
        const errors = fieldErrors(error);
        assert.ok(errors.CONTROL_PLANE_BASE_URL?.length);
        assert.ok(errors.CORS_ORIGIN?.length);
        assert.ok(errors.OIDC_CLIENT_SECRET?.length);
        assert.ok(errors.CSRF_SECRET?.length);
        assert.ok(errors.ORCH_SERVICE_TOKEN?.length);
        assert.ok(errors.EXTERNAL_INTEGRATION_CLIENTS_JSON?.length);
        assert.ok(errors.EXECUTION_ENGINE_DISPATCH_TOKEN?.length);
        assert.ok(errors.DATABASE_URL?.length);
        assert.ok(errors.LLM_GATEWAY_ADMIN_TOKEN?.length);
        assert.ok(errors.GATEWAY_SIGNING_PRIVATE_KEY_PEM_B64?.length);
        assert.ok(errors.WEBHOOK_SECRET_ENCRYPTION_KEY?.length);
        assert.ok(errors.SEED_DEVELOPMENT_DATA?.length);
        return true;
      }
    );
  });

  it('keeps development defaults usable for local workflows', () => {
    const config = parseAppConfig({});
    const nullConfig = parseAppConfig({ WORKSPACE_ROLES_CONFIG_JSON: 'null' });

    assert.equal(config.NODE_ENV, 'development');
    assert.equal(config.ORCH_SERVICE_TOKEN, 'dev_orchestrator_token');
    assert.equal(config.EXTERNAL_INTEGRATION_CLIENTS[0].id, 'dev-client');
    assert.equal(config.CONTROL_PLANE_AGENT_SNAPSHOT_INTERVAL_SECONDS, 60);
    assert.equal(config.MANAGEMENT_CONSOLE_BASE_URL, 'http://localhost:3000');
    assert.equal(config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED, false);
    assert.equal(config.AGENT_WS_REQUIRE_SECURE_TRANSPORT, false);
    assert.equal(config.PASSWORD_SIGNUP_ENABLED, true);
    assert.equal(config.SEED_DEVELOPMENT_DATA, false);
    assert.equal(config.SESSION_MAX_AGE_SECONDS, 604800);
    assert.equal(config.SESSION_IDLE_TIMEOUT_SECONDS, 86400);
    assert.equal(config.TARGET_CHAT_RECENT_ACTIVITY_WINDOW_SECONDS, 300);
    assert.equal(config.WORKSPACE_AUDIT_LOGGING_MODE, 'read_write');
    assert.deepEqual([config.WORKSPACE_AUDIT_RETENTION_DAYS, config.TARGET_METRIC_HISTORY_RETENTION_DAYS], [365, 30]);
    assert.deepEqual(config.WORKSPACE_ROLE_TEMPLATES.map((role) => role.key), ['owner', 'admin', 'operator', 'viewer', 'auditor']);
    assert.deepEqual(nullConfig.WORKSPACE_ROLE_TEMPLATES.map((role) => role.key), ['owner', 'admin', 'operator', 'viewer', 'auditor']);
    assert.equal(config.INTERNAL_TRANSPORT_TLS_ENABLED, false);
    assert.equal(config.INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT, true);
    assert.equal(config.ADDITIONAL_CA_BUNDLE_FILE, undefined);
  });

  it('allows development seeding only through explicit opt-in', () => {
    const config = parseAppConfig({ SEED_DEVELOPMENT_DATA: 'true' });

    assert.equal(config.NODE_ENV, 'development');
    assert.equal(config.SEED_DEVELOPMENT_DATA, true);
  });

  it('requires readable TLS files and HTTPS internal URLs when internal transport TLS is enabled', () => {
    assert.throws(
      () =>
        parseAppConfig({
          INTERNAL_TRANSPORT_TLS_ENABLED: 'true',
          EXECUTION_ENGINE_BASE_URL: 'http://execution-engine:8080',
          LLM_GATEWAY_URL: 'http://llm-gateway:8001',
          BUILTIN_TARGET_MCP_SERVER_URL: 'http://control-plane:8081/internal/v1/mcp'
        }),
      (error) => {
        const errors = fieldErrors(error);
        assert.ok(errors.INTERNAL_TRANSPORT_TLS_CA_FILE?.length);
        assert.ok(errors.INTERNAL_TRANSPORT_TLS_CERT_FILE?.length);
        assert.ok(errors.INTERNAL_TRANSPORT_TLS_KEY_FILE?.length);
        assert.ok(errors.EXECUTION_ENGINE_BASE_URL?.length);
        assert.ok(errors.LLM_GATEWAY_URL?.length);
        assert.ok(errors.BUILTIN_TARGET_MCP_SERVER_URL?.length);
        return true;
      }
    );
  });

  it('requires the CA file when internal TLS is enabled without client certificate enforcement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acornops-cp-tls-no-client-cert-'));
    const certFile = join(dir, 'tls.crt');
    const keyFile = join(dir, 'tls.key');
    writeFileSync(certFile, 'test cert');
    writeFileSync(keyFile, 'test key');

    assert.throws(
      () =>
        parseAppConfig({
          INTERNAL_TRANSPORT_TLS_ENABLED: 'true',
          INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT: 'false',
          INTERNAL_TRANSPORT_TLS_CERT_FILE: certFile,
          INTERNAL_TRANSPORT_TLS_KEY_FILE: keyFile,
          EXECUTION_ENGINE_BASE_URL: 'https://execution-engine.acornops.svc:8080',
          LLM_GATEWAY_URL: 'https://llm-gateway.acornops.svc:8001',
          BUILTIN_TARGET_MCP_SERVER_URL: 'https://control-plane.acornops.svc:8443/internal/v1/mcp'
        }),
      (error) => {
        const errors = fieldErrors(error);
        assert.ok(errors.INTERNAL_TRANSPORT_TLS_CA_FILE?.length);
        return true;
      }
    );
  });

  it('accepts enabled internal transport TLS with readable files and HTTPS internal URLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acornops-cp-tls-'));
    const caFile = join(dir, 'ca.crt');
    const certFile = join(dir, 'tls.crt');
    const keyFile = join(dir, 'tls.key');
    writeFileSync(caFile, 'test ca');
    writeFileSync(certFile, 'test cert');
    writeFileSync(keyFile, 'test key');

    const config = parseAppConfig({
      INTERNAL_TRANSPORT_TLS_ENABLED: 'true',
      INTERNAL_TRANSPORT_TLS_CA_FILE: caFile,
      INTERNAL_TRANSPORT_TLS_CERT_FILE: certFile,
      INTERNAL_TRANSPORT_TLS_KEY_FILE: keyFile,
      EXECUTION_ENGINE_BASE_URL: 'https://execution-engine.acornops.svc:8080',
      LLM_GATEWAY_URL: 'https://llm-gateway.acornops.svc:8001',
      BUILTIN_TARGET_MCP_SERVER_URL: 'https://control-plane.acornops.svc:8443/internal/v1/mcp'
    });

    assert.equal(config.INTERNAL_TRANSPORT_TLS_ENABLED, true);
    assert.equal(config.INTERNAL_TRANSPORT_TLS_CA_FILE, caFile);
  });

  it('allows operators to override secure agent upgrade enforcement explicitly', () => {
    const config = parseAppConfig(productionEnv({
      AGENT_WS_REQUIRE_SECURE_TRANSPORT: 'false'
    }));

    assert.equal(config.AGENT_WS_REQUIRE_SECURE_TRANSPORT, false);
  });

  it('parses workspace audit logging mode and retention settings', () => {
    for (const mode of ['read_write', 'write_only', 'disabled']) {
      const config = parseAppConfig({
        WORKSPACE_AUDIT_LOGGING_MODE: mode,
        WORKSPACE_AUDIT_RETENTION_DAYS: '90',
        TARGET_METRIC_HISTORY_RETENTION_DAYS: '14'
      });
      assert.equal(config.WORKSPACE_AUDIT_LOGGING_MODE, mode);
      assert.equal(config.WORKSPACE_AUDIT_RETENTION_DAYS, 90);
      assert.equal(config.TARGET_METRIC_HISTORY_RETENTION_DAYS, 14);
    }
  });

  it('rejects invalid workspace audit logging settings', () => {
    assert.throws(
      () => parseAppConfig({ WORKSPACE_AUDIT_LOGGING_MODE: 'all' }),
      (error) => Boolean(fieldErrors(error).WORKSPACE_AUDIT_LOGGING_MODE?.length)
    );

    for (const value of ['0', '-1', '1.5', 'forever']) {
      assert.throws(
        () => parseAppConfig({ WORKSPACE_AUDIT_RETENTION_DAYS: value }),
        (error) => Boolean(fieldErrors(error).WORKSPACE_AUDIT_RETENTION_DAYS?.length)
      );
      assert.throws(
        () => parseAppConfig({ TARGET_METRIC_HISTORY_RETENTION_DAYS: value }),
        (error) => Boolean(fieldErrors(error).TARGET_METRIC_HISTORY_RETENTION_DAYS?.length)
      );
    }
  });

  it('parses custom workspace role templates and rejects unsafe role config', () => {
    const config = parseAppConfig({
      WORKSPACE_ROLES_CONFIG_JSON: JSON.stringify({
        enabledBuiltIns: ['owner', 'viewer'],
        customTemplates: [
          {
            key: 'support_lead',
            displayName: 'Support Lead',
            description: 'Can manage ordinary memberships and read logs.',
            capabilities: ['read_members', 'manage_members', 'read_tarquery_logs'],
            sortOrder: 150
          }
        ]
      })
    });

    assert.deepEqual(config.WORKSPACE_ROLE_TEMPLATES.map((role) => role.key), ['owner', 'support_lead', 'viewer']);
    assert.equal(config.WORKSPACE_ROLE_TEMPLATES.find((role) => role.key === 'support_lead')?.kind, 'custom');

    assert.throws(
      () =>
        parseAppConfig({
          WORKSPACE_ROLES_CONFIG_JSON: JSON.stringify({
            enabledBuiltIns: ['viewer']
          })
        }),
      /must include owner/
    );
    assert.throws(
      () =>
        parseAppConfig({
          WORKSPACE_ROLES_CONFIG_JSON: JSON.stringify({
            enabledBuiltIns: ['owner'],
            customTemplates: [{ key: 'ops_root', displayName: 'Ops Root', capabilities: ['delete_workspace'] }]
          })
        }),
      /owner-only capability delete_workspace/
    );
    assert.throws(
      () =>
        parseAppConfig({
          WORKSPACE_ROLES_CONFIG_JSON: JSON.stringify({
            enabledBuiltIns: ['owner'],
            unexpected: true
          })
        }),
      /Unrecognized key/
    );
  });

  it('requires a production-safe verification email base URL when password signup is enabled', () => {
    assert.throws(
      () =>
        parseAppConfig(
          productionEnv({
            PASSWORD_SIGNUP_ENABLED: 'true',
            EMAIL_DELIVERY_MODE: 'smtp',
            SMTP_HOST: 'smtp.example.com',
            SMTP_USERNAME: 'apikey',
            SMTP_PASSWORD: 'smtp_password_0123456789',
            EMAIL_PUBLIC_BASE_URL: 'http://localhost:3000'
          })
        ),
      (error) => {
        const errors = fieldErrors(error);
        assert.ok(errors.EMAIL_PUBLIC_BASE_URL?.length);
        return true;
      }
    );
  });

  it('requires production-safe password reset email delivery configuration', () => {
    assert.throws(
      () =>
        parseAppConfig(
          productionEnv({
            PASSWORD_RESET_ENABLED: 'true',
            EMAIL_DELIVERY_MODE: 'log',
            EMAIL_PUBLIC_BASE_URL: 'http://localhost:3000'
          })
        ),
      (error) => {
        const errors = fieldErrors(error);
        assert.ok(errors.EMAIL_DELIVERY_MODE?.length);
        assert.ok(errors.EMAIL_PUBLIC_BASE_URL?.length);
        return true;
      }
    );
  });

  it('allows production password reset log delivery only behind the explicit unsafe override', () => {
    const config = parseAppConfig(
      productionEnv({
        PASSWORD_RESET_ENABLED: 'true',
        EMAIL_DELIVERY_MODE: 'log',
        EMAIL_DELIVERY_ALLOW_LOG_IN_PRODUCTION: 'true',
        EMAIL_PUBLIC_BASE_URL: 'https://ops.example.com'
      })
    );

    assert.equal(config.PASSWORD_RESET_ENABLED, true);
    assert.equal(config.EMAIL_DELIVERY_MODE, 'log');
  });

  it('does not require password email delivery when password auth is disabled in production', () => {
    const config = parseAppConfig(
      productionEnv({
        PASSWORD_AUTH_ENABLED: 'false',
        PASSWORD_SIGNUP_ENABLED: 'true',
        PASSWORD_RESET_ENABLED: 'true',
        EMAIL_DELIVERY_MODE: 'disabled',
        EMAIL_PUBLIC_BASE_URL: 'http://localhost:3000'
      })
    );

    assert.equal(config.PASSWORD_AUTH_ENABLED, false);
    assert.equal(config.PASSWORD_RESET_ENABLED, true);
    assert.equal(config.EMAIL_DELIVERY_MODE, 'disabled');
  });

  it('allows explicit distributed routing overrides outside production', () => {
    const config = parseAppConfig({
      CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED: 'true',
      CONTROL_PLANE_INSTANCE_ID: 'cp-test-1',
      CONTROL_PLANE_AGENT_OWNER_TTL_SECONDS: '45'
    });

    assert.equal(config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED, true);
    assert.equal(config.CONTROL_PLANE_INSTANCE_ID, 'cp-test-1');
    assert.equal(config.CONTROL_PLANE_AGENT_OWNER_TTL_SECONDS, 45);
  });

  it('prefers explicit session max age over legacy session TTL', () => {
    const config = parseAppConfig({
      SESSION_TTL_SECONDS: '172800',
      SESSION_MAX_AGE_SECONDS: '604800',
      SESSION_IDLE_TIMEOUT_SECONDS: '86400'
    });

    assert.equal(config.SESSION_MAX_AGE_SECONDS, 604800);
  });

  it('rejects a session idle timeout longer than the max age', () => {
    assert.throws(
      () =>
        parseAppConfig({
          SESSION_MAX_AGE_SECONDS: '3600',
          SESSION_IDLE_TIMEOUT_SECONDS: '7200'
        }),
      (error) => {
        const errors = fieldErrors(error);
        assert.ok(errors.SESSION_IDLE_TIMEOUT_SECONDS?.length);
        return true;
      }
    );
  });

  it('normalizes comma-separated CORS origins for allow-list use', () => {
    assert.deepEqual(parseAllowedOrigins('https://console.example.com, https://admin.example.com,https://console.example.com'), [
      'https://console.example.com',
      'https://admin.example.com'
    ]);
  });
});
