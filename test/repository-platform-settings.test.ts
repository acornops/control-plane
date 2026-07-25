import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  PlatformSettingVersionConflictError,
  writePlatformSettingOverride
} from '../src/store/repository-platform-settings.js';

afterEach(() => mock.restoreAll());

const auditEvent = {
  adminTokenId: 'platform-console',
  action: 'admin.system.setting.update',
  outcome: 'success' as const,
  subjectType: 'platform_setting',
  subjectId: 'member_discovery',
  reason: 'Enable trusted directory',
  requestId: 'request-1',
  metadata: { settingKey: 'member_discovery' }
};

describe('platform setting persistence', () => {
  it('commits the versioned override and audit event in the same transaction', async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
        if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
        if (sql.includes('FROM platform_setting_overrides') && sql.includes('FOR UPDATE')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('INSERT INTO platform_setting_overrides')) {
          return {
            rowCount: 1,
            rows: [{
              key: 'member_discovery',
              override_value: { mode: 'directory' },
              version: 1,
              updated_by: 'admin-subject',
              updated_at: new Date('2026-07-25T00:00:00.000Z')
            }]
          };
        }
        if (sql.includes('INSERT INTO admin_audit_events')) {
          return {
            rowCount: 1,
            rows: [{
              id: 'audit-1',
              admin_token_id: 'platform-console',
              action: auditEvent.action,
              outcome: 'success',
              subject_type: 'platform_setting',
              subject_id: 'member_discovery',
              reason: auditEvent.reason,
              request_id: 'request-1',
              metadata: auditEvent.metadata,
              occurred_at: new Date('2026-07-25T00:00:00.000Z')
            }]
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      release() {}
    };
    mock.method(db, 'connect', async () => client as never);

    const stored = await writePlatformSettingOverride({
      key: 'member_discovery',
      overrideValue: { mode: 'directory' },
      expectedVersion: 0,
      updatedBy: 'admin-subject',
      auditEvent
    });

    assert.equal(stored.version, 1);
    assert.deepEqual(stored.overrideValue, { mode: 'directory' });
    assert.ok(
      statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock')) <
      statements.findIndex((sql) => sql.includes('FROM platform_setting_overrides'))
    );
    assert.ok(
      statements.findIndex((sql) => sql.includes('INSERT INTO platform_setting_overrides')) <
      statements.findIndex((sql) => sql.includes('INSERT INTO admin_audit_events'))
    );
    assert.equal(statements.at(-1), 'COMMIT');
  });

  it('rolls back without auditing when optimistic version validation fails', async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
        if (sql === 'COMMIT') throw new Error('commit must not be reached');
        if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
        if (sql.includes('FROM platform_setting_overrides') && sql.includes('FOR UPDATE')) {
          return {
            rowCount: 1,
            rows: [{
              key: 'member_discovery',
              override_value: { mode: 'exact_email' },
              version: 3,
              updated_by: 'other-admin',
              updated_at: new Date()
            }]
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      release() {}
    };
    mock.method(db, 'connect', async () => client as never);

    await assert.rejects(
      () => writePlatformSettingOverride({
        key: 'member_discovery',
        overrideValue: { mode: 'directory' },
        expectedVersion: 2,
        updatedBy: 'admin-subject',
        auditEvent
      }),
      (error) => error instanceof PlatformSettingVersionConflictError && error.currentVersion === 3
    );
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.equal(statements.some((sql) => sql.includes('INSERT INTO admin_audit_events')), false);
  });
});
