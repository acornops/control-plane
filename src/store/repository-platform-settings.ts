import type { PoolClient } from 'pg';
import type { PlatformSettingKey } from '../config-platform-settings.js';
import { db } from '../infra/db.js';
import type { AdminAuditEventInput } from './repository-admin-audit.js';
import { insertAdminAuditEvent } from './repository-admin-audit.js';
import { toIso } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';

interface PlatformSettingOverrideRow {
  key: PlatformSettingKey;
  override_value: unknown | null;
  version: number;
  updated_by: string | null;
  updated_at: Date | string;
}

export interface PlatformSettingOverride {
  key: PlatformSettingKey;
  overrideValue: unknown | null;
  version: number;
  updatedBy?: string;
  updatedAt: string;
}

function mapPlatformSettingOverride(row: PlatformSettingOverrideRow): PlatformSettingOverride {
  return {
    key: row.key,
    overrideValue: row.override_value,
    version: Number(row.version),
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
    updatedAt: toIso(row.updated_at)!
  };
}

export class PlatformSettingVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('Platform setting was changed by another administrator');
  }
}

export async function listPlatformSettingOverrides(): Promise<PlatformSettingOverride[]> {
  const result = await db.query<PlatformSettingOverrideRow>(
    `SELECT key, override_value, version, updated_by, updated_at
     FROM platform_setting_overrides
     ORDER BY key ASC`
  );
  return result.rows.map(mapPlatformSettingOverride);
}

export async function writePlatformSettingOverride(input: {
  key: PlatformSettingKey;
  overrideValue: unknown | null;
  expectedVersion: number;
  updatedBy?: string;
  auditEvent: AdminAuditEventInput;
}): Promise<PlatformSettingOverride> {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.key]);
    const current = await client.query<PlatformSettingOverrideRow>(
      `SELECT key, override_value, version, updated_by, updated_at
       FROM platform_setting_overrides
       WHERE key = $1
       FOR UPDATE`,
      [input.key]
    );
    const currentVersion = current.rowCount ? Number(current.rows[0].version) : 0;
    if (currentVersion !== input.expectedVersion) {
      throw new PlatformSettingVersionConflictError(currentVersion);
    }

    const result = current.rowCount
      ? await client.query<PlatformSettingOverrideRow>(
        `UPDATE platform_setting_overrides
         SET override_value = $2::jsonb,
             version = version + 1,
             updated_by = $3,
             updated_at = NOW()
         WHERE key = $1
         RETURNING key, override_value, version, updated_by, updated_at`,
        [input.key, input.overrideValue === null ? null : JSON.stringify(input.overrideValue), input.updatedBy || null]
      )
      : await client.query<PlatformSettingOverrideRow>(
        `INSERT INTO platform_setting_overrides (key, override_value, version, updated_by, updated_at)
         VALUES ($1, $2::jsonb, 1, $3, NOW())
         RETURNING key, override_value, version, updated_by, updated_at`,
        [input.key, input.overrideValue === null ? null : JSON.stringify(input.overrideValue), input.updatedBy || null]
      );
    await insertAdminAuditEvent(input.auditEvent, client as PoolClient);
    return mapPlatformSettingOverride(result.rows[0]);
  });
}
