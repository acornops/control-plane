import { db } from '../infra/db.js';

export interface ToolResultArtifactRecord {
  id: string;
  runId: string;
  workspaceId: string;
  callId: string;
  toolName: string;
  sha256: string;
  contentType: string;
  encoding: string;
  uncompressedBytes: number;
  compressedBytes: number;
  payload: Buffer;
  createdAt: string;
  expiresAt: string;
}

interface ToolResultArtifactRow {
  id: string;
  run_id: string;
  workspace_id: string;
  call_id: string;
  tool_name: string;
  sha256: string;
  content_type: string;
  encoding: string;
  uncompressed_bytes: number | string;
  compressed_bytes: number | string;
  payload: Buffer;
  created_at: Date | string;
  expires_at: Date | string;
}

function mapArtifact(row: ToolResultArtifactRow): ToolResultArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    callId: row.call_id,
    toolName: row.tool_name,
    sha256: row.sha256,
    contentType: row.content_type,
    encoding: row.encoding,
    uncompressedBytes: Number(row.uncompressed_bytes),
    compressedBytes: Number(row.compressed_bytes),
    payload: row.payload,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export async function upsertToolResultArtifact(input: Omit<ToolResultArtifactRecord, 'createdAt'>): Promise<ToolResultArtifactRecord> {
  const result = await db.query(
    `INSERT INTO run_tool_result_artifacts (
       id, run_id, workspace_id, call_id, tool_name, sha256, content_type, encoding,
       uncompressed_bytes, compressed_bytes, payload, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (run_id, call_id) DO UPDATE SET
       call_id = run_tool_result_artifacts.call_id
     RETURNING *`,
    [input.id, input.runId, input.workspaceId, input.callId, input.toolName, input.sha256,
      input.contentType, input.encoding, input.uncompressedBytes, input.compressedBytes,
      input.payload, input.expiresAt]
  );
  return mapArtifact(result.rows[0] as ToolResultArtifactRow);
}

export async function getToolResultArtifact(runId: string, artifactId: string): Promise<ToolResultArtifactRecord | null> {
  const result = await db.query(
    `SELECT * FROM run_tool_result_artifacts
     WHERE id = $1 AND run_id = $2 AND expires_at > NOW()`,
    [artifactId, runId]
  );
  return result.rowCount ? mapArtifact(result.rows[0] as ToolResultArtifactRow) : null;
}

export async function purgeExpiredToolResultArtifacts(limit: number): Promise<number> {
  const result = await db.query(
    `WITH candidate AS (
       SELECT id FROM run_tool_result_artifacts
       WHERE expires_at <= NOW() ORDER BY expires_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
     ) DELETE FROM run_tool_result_artifacts a USING candidate c WHERE a.id = c.id`,
    [Math.max(1, Math.min(5000, limit))]
  );
  return result.rowCount ?? 0;
}
