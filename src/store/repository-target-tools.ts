import { db } from '../infra/db.js';
import { TargetToolOverrideRow } from './repository-mappers.js';

interface TargetToolSettingRow {
  target_id: string;
  tool_id: string;
  enabled: boolean;
  config_json: Record<string, unknown>;
  updated_at: Date;
}

export interface TargetToolSetting {
  targetId: string;
  toolId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  updatedAt: string;
}

export async function listTargetToolOverrides(targetId: string): Promise<Record<string, boolean>> {
  const result = await db.query(
    'SELECT target_id, tool_name, enabled FROM target_tool_overrides WHERE target_id = $1',
    [targetId]
  );
  const overrides: Record<string, boolean> = {};
  for (const row of result.rows as TargetToolOverrideRow[]) {
    overrides[row.tool_name] = Boolean(row.enabled);
  }
  return overrides;
}

export async function setTargetToolOverride(targetId: string, toolName: string, enabled: boolean): Promise<void> {
  await db.query(
    `INSERT INTO target_tool_overrides (target_id, tool_name, enabled, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (target_id, tool_name) DO UPDATE
     SET enabled = EXCLUDED.enabled,
         updated_at = NOW()`,
    [targetId, toolName, enabled]
  );
}

function mapTargetToolSetting(row: TargetToolSettingRow): TargetToolSetting {
  return {
    targetId: row.target_id,
    toolId: row.tool_id,
    enabled: Boolean(row.enabled),
    config: row.config_json || {},
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function listTargetToolSettings(targetId: string): Promise<TargetToolSetting[]> {
  const result = await db.query(
    `SELECT target_id, tool_id, enabled, config_json, updated_at
     FROM target_tool_settings
     WHERE target_id = $1
     ORDER BY tool_id ASC`,
    [targetId]
  );
  return (result.rows as TargetToolSettingRow[]).map(mapTargetToolSetting);
}

export async function getTargetToolSetting(targetId: string, toolId: string): Promise<TargetToolSetting | null> {
  const result = await db.query(
    `SELECT target_id, tool_id, enabled, config_json, updated_at
     FROM target_tool_settings
     WHERE target_id = $1 AND tool_id = $2`,
    [targetId, toolId]
  );
  return result.rows[0] ? mapTargetToolSetting(result.rows[0] as TargetToolSettingRow) : null;
}

export async function listEnabledTargetToolSettings(targetId: string): Promise<TargetToolSetting[]> {
  const result = await db.query(
    `SELECT target_id, tool_id, enabled, config_json, updated_at
     FROM target_tool_settings
     WHERE target_id = $1 AND enabled = TRUE
     ORDER BY tool_id ASC`,
    [targetId]
  );
  return (result.rows as TargetToolSettingRow[]).map(mapTargetToolSetting);
}

export async function upsertTargetToolSetting(
  targetId: string,
  toolId: string,
  enabled: boolean,
  config: Record<string, unknown>
): Promise<TargetToolSetting> {
  const result = await db.query(
    `INSERT INTO target_tool_settings (target_id, tool_id, enabled, config_json, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (target_id, tool_id) DO UPDATE
     SET enabled = EXCLUDED.enabled,
         config_json = EXCLUDED.config_json,
         updated_at = NOW()
     RETURNING target_id, tool_id, enabled, config_json, updated_at`,
    [targetId, toolId, enabled, JSON.stringify(config)]
  );
  return mapTargetToolSetting(result.rows[0] as TargetToolSettingRow);
}
