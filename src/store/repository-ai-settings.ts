import { db } from '../infra/db.js';
import { LlmProvider, ReasoningEffort, ReasoningSummaryMode, WorkspaceAiSettings } from '../types/domain.js';

interface WorkspaceAiSettingsRow {
  workspace_id: string;
  default_provider: LlmProvider;
  default_model: string;
  reasoning_summary_mode: ReasoningSummaryMode;
  reasoning_effort: ReasoningEffort;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapWorkspaceAiSettings(row: WorkspaceAiSettingsRow): WorkspaceAiSettings {
  return {
    workspaceId: row.workspace_id,
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
    reasoningSummaryMode: row.reasoning_summary_mode,
    reasoningEffort: row.reasoning_effort,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function getWorkspaceAiSettings(workspaceId: string): Promise<WorkspaceAiSettings | null> {
  const result = await db.query<WorkspaceAiSettingsRow>(
    `SELECT workspace_id, default_provider, default_model, reasoning_summary_mode, reasoning_effort, created_at, updated_at
     FROM workspace_ai_settings
     WHERE workspace_id = $1
     LIMIT 1`,
    [workspaceId]
  );
  return result.rowCount ? mapWorkspaceAiSettings(result.rows[0]) : null;
}

export async function upsertWorkspaceAiSettings(
  workspaceId: string,
  input: {
    defaultProvider: LlmProvider;
    defaultModel: string;
    reasoningSummaryMode: ReasoningSummaryMode;
    reasoningEffort: ReasoningEffort;
  }
): Promise<WorkspaceAiSettings> {
  const result = await db.query<WorkspaceAiSettingsRow>(
    `INSERT INTO workspace_ai_settings (
       workspace_id, default_provider, default_model, reasoning_summary_mode, reasoning_effort, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (workspace_id) DO UPDATE
     SET default_provider = EXCLUDED.default_provider,
         default_model = EXCLUDED.default_model,
         reasoning_summary_mode = EXCLUDED.reasoning_summary_mode,
         reasoning_effort = EXCLUDED.reasoning_effort,
         updated_at = NOW()
     RETURNING workspace_id, default_provider, default_model, reasoning_summary_mode, reasoning_effort, created_at, updated_at`,
    [
      workspaceId,
      input.defaultProvider,
      input.defaultModel,
      input.reasoningSummaryMode,
      input.reasoningEffort
    ]
  );
  return mapWorkspaceAiSettings(result.rows[0]);
}
