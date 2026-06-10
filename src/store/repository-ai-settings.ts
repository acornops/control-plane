import { db } from '../infra/db.js';
import { LlmProvider, WorkspaceAiSettings } from '../types/domain.js';

interface WorkspaceAiSettingsRow {
  workspace_id: string;
  default_provider: LlmProvider;
  default_model: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapWorkspaceAiSettings(row: WorkspaceAiSettingsRow): WorkspaceAiSettings {
  return {
    workspaceId: row.workspace_id,
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function getWorkspaceAiSettings(workspaceId: string): Promise<WorkspaceAiSettings | null> {
  const result = await db.query<WorkspaceAiSettingsRow>(
    `SELECT workspace_id, default_provider, default_model, created_at, updated_at
     FROM workspace_ai_settings
     WHERE workspace_id = $1
     LIMIT 1`,
    [workspaceId]
  );
  return result.rowCount ? mapWorkspaceAiSettings(result.rows[0]) : null;
}

export async function upsertWorkspaceAiSettings(
  workspaceId: string,
  input: { defaultProvider: LlmProvider; defaultModel: string }
): Promise<WorkspaceAiSettings> {
  const result = await db.query<WorkspaceAiSettingsRow>(
    `INSERT INTO workspace_ai_settings (workspace_id, default_provider, default_model, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (workspace_id) DO UPDATE
     SET default_provider = EXCLUDED.default_provider,
         default_model = EXCLUDED.default_model,
         updated_at = NOW()
     RETURNING workspace_id, default_provider, default_model, created_at, updated_at`,
    [workspaceId, input.defaultProvider, input.defaultModel]
  );
  return mapWorkspaceAiSettings(result.rows[0]);
}
