import { db } from '../infra/db.js';
import { TargetToolOverrideRow } from './repository-mappers.js';

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
