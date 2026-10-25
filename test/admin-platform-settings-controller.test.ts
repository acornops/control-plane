import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { Response } from 'express';
import type { AdminAuthenticatedRequest } from '../src/auth/admin-token.js';
import { config } from '../src/config.js';
import { resetSetting, updateSetting } from '../src/controllers/admin-platform-settings-controller.js';
import { db } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import { applyPlatformSettingOverrides, getPlatformSetting } from '../src/services/platform-settings.js';

const originalPolicy = config.PLATFORM_SETTINGS_POLICY;
const additions = { openai: ['gpt-future'], anthropic: [], gemini: [] };

beforeEach(() => {
  config.PLATFORM_SETTINGS_POLICY = {
    ...originalPolicy, aiPolicy: { runtimeEditable: true, allowAdditionalModels: true }
  };
  applyPlatformSettingOverrides([]);
  mock.method(redis, 'publish', async () => 0);
});
afterEach(() => {
  mock.restoreAll();
  config.PLATFORM_SETTINGS_POLICY = originalPolicy;
  applyPlatformSettingOverrides([]);
});

function database(options: { concurrentWrite?: boolean; readFailure?: Error } = {}) {
  const row = {
    key: 'ai_policy',
    override_value: { ...getPlatformSetting('ai_policy').deploymentDefault, additionalProviderModels: additions } as unknown,
    version: 1, updated_by: 'admin', updated_at: new Date('2026-10-25T00:00:00Z')
  };
  const evidence = { writes: 0, audits: [] as Array<Record<string, unknown>> };
  mock.method(db, 'query', async (sql: string) => {
    assert.match(sql, /FROM platform_setting_overrides/);
    if (options.readFailure) throw options.readFailure;
    return { rows: [structuredClone(row)], rowCount: 1 } as never;
  });
  mock.method(db, 'connect', async () => ({
    async query(sql: string, values: unknown[] = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FOR UPDATE')) {
        return { rows: [{ ...row, version: options.concurrentWrite ? 2 : row.version }], rowCount: 1 };
      }
      if (sql.includes('UPDATE platform_setting_overrides')) {
        row.override_value = values[1] === null ? null : JSON.parse(String(values[1]));
        row.version += 1;
        evidence.writes += 1;
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO admin_audit_events')) {
        const metadata = JSON.parse(String(values[20]));
        evidence.audits.push(metadata);
        return { rows: [{ id: 'audit-1', action: values[9], outcome: values[10], request_id: values[17], metadata, occurred_at: row.updated_at }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {}
  }) as never);
  return { row, evidence };
}

async function call(handler: typeof updateSetting, value?: unknown) {
  const result = { status: 200, body: undefined as any, error: undefined as unknown };
  const res = {
    locals: { requestId: 'request-1' },
    status(code: number) { result.status = code; return this; },
    json(body: unknown) { result.body = body; return this; }
  } as Response;
  const req = {
    params: { settingKey: 'ai_policy' },
    body: { value, expectedVersion: 1, reason: 'Update AI policy' },
    admin: { tokenId: 'admin-test' },
    ip: '127.0.0.1', header: () => undefined, res
  } as unknown as AdminAuthenticatedRequest;
  await handler(req, res, (error) => { result.error = error; });
  return result;
}

describe('AI policy request freshness', () => {
  it('preserves fresh catalog metadata and audits it when a legacy client hits a stale replica', async () => {
    const { row, evidence } = database();
    const response = await call(updateSetting, getPlatformSetting('ai_policy').deploymentDefault);
    assert.equal(response.error, undefined);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.value.additionalProviderModels, additions);
    assert.deepEqual((row.override_value as any).additionalProviderModels, additions);
    assert.deepEqual((evidence.audits[0].after as any).additionalProviderModels, additions);
    assert.deepEqual((evidence.audits[0].before as any).additionalProviderModels, additions);
    assert.equal(evidence.writes, 1);
  });

  it('does not write or audit when another administrator writes after the refresh', async () => {
    const { evidence } = database({ concurrentWrite: true });
    const response = await call(updateSetting, getPlatformSetting('ai_policy').deploymentDefault);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'VERSION_CONFLICT');
    assert.equal(evidence.writes, 0);
    assert.equal(evidence.audits.length, 0);
  });

  it('fails closed without a write when durable policy refresh fails', async () => {
    const readFailure = new Error('Database unavailable');
    const { evidence } = database({ readFailure });
    const response = await call(updateSetting, getPlatformSetting('ai_policy').deploymentDefault);
    assert.equal(response.error, readFailure);
    assert.equal(evidence.writes, 0);
  });

  it('removes the custom catalog only when the policy is explicitly reset', async () => {
    const { row } = database();
    const response = await call(resetSetting);
    assert.equal(response.error, undefined);
    assert.equal(response.status, 200);
    assert.equal(row.override_value, null);
    assert.equal(response.body.value.additionalProviderModels, undefined);
  });
});
