import { db } from '../infra/db.js';
import { RecentTargetChatActivity } from '../types/domain.js';
import { toIso } from './repository-mappers.js';

interface RecentTargetChatActivityRow {
  session_id: string;
  title: string;
  created_by: string;
  created_by_user_id?: string | null;
  created_by_display_name?: string | null;
  last_activity_at: Date | string;
  last_run_id: string | null;
  last_run_status: RecentTargetChatActivity['lastRunStatus'] | null;
  latest_tool_access_mode: RecentTargetChatActivity['latestToolAccessMode'] | null;
  active_run_id: string | null;
  active_run_status: NonNullable<RecentTargetChatActivity['activeRun']>['status'] | null;
  active_run_tool_access_mode: NonNullable<RecentTargetChatActivity['activeRun']>['toolAccessMode'] | null;
  active_run_requested_at: Date | string | null;
  has_active_run: boolean;
  has_recent_write_capable_run: boolean;
}

function mapRecentTargetChatActivity(row: RecentTargetChatActivityRow): RecentTargetChatActivity {
  const activeRun = row.active_run_id && row.active_run_status && row.active_run_tool_access_mode && row.active_run_requested_at
    ? {
        runId: row.active_run_id,
        status: row.active_run_status,
        toolAccessMode: row.active_run_tool_access_mode,
        requestedAt: toIso(row.active_run_requested_at)!
      }
    : undefined;
  return {
    sessionId: row.session_id,
    title: row.title,
    createdBy: row.created_by,
    createdByUser: row.created_by_user_id && row.created_by_display_name
      ? {
          id: row.created_by_user_id,
          displayName: row.created_by_display_name
        }
      : undefined,
    lastActivityAt: toIso(row.last_activity_at)!,
    lastRunId: row.last_run_id || undefined,
    lastRunStatus: row.last_run_status || undefined,
    activeRun,
    hasActiveRun: Boolean(row.has_active_run),
    hasRecentWriteCapableRun: Boolean(row.has_recent_write_capable_run),
    latestToolAccessMode: row.latest_tool_access_mode || undefined
  };
}

export async function listRecentTargetChatActivity(
  workspaceId: string,
  targetId: string,
  windowSeconds: number
): Promise<RecentTargetChatActivity[]> {
  const boundedWindowSeconds = Math.max(60, Math.min(3600, windowSeconds));
  const result = await db.query(
    `WITH recent_activity AS (
       SELECT m.session_id, MAX(m.created_at) AS last_activity_at
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE s.workspace_id = $1
         AND s.target_id = $2
         AND s.deleted_at IS NULL
         AND s.expires_at > NOW()
         AND m.created_at >= NOW() - ($3::int * INTERVAL '1 second')
       GROUP BY m.session_id
       UNION ALL
       SELECT r.session_id, MAX(r.requested_at) AS last_activity_at
       FROM runs r
       JOIN sessions s ON s.id = r.session_id
       WHERE s.workspace_id = $1
         AND s.target_id = $2
         AND s.deleted_at IS NULL
         AND s.expires_at > NOW()
         AND r.requested_at >= NOW() - ($3::int * INTERVAL '1 second')
       GROUP BY r.session_id
     ), per_session AS (
       SELECT session_id, MAX(last_activity_at) AS last_activity_at
       FROM recent_activity
       GROUP BY session_id
     )
     SELECT
       s.id AS session_id,
       s.title,
       s.created_by,
       u.id AS created_by_user_id,
       u.display_name AS created_by_display_name,
       ps.last_activity_at,
       latest_run.id AS last_run_id,
       latest_run.status AS last_run_status,
       latest_run.tool_access_mode AS latest_tool_access_mode,
       active_run.id AS active_run_id,
       active_run.status AS active_run_status,
       active_run.tool_access_mode AS active_run_tool_access_mode,
       active_run.requested_at AS active_run_requested_at,
       active_run.id IS NOT NULL AS has_active_run,
       EXISTS (
         SELECT 1
         FROM runs recent_write_run
         WHERE recent_write_run.session_id = s.id
           AND recent_write_run.tool_access_mode = 'read_write'
           AND recent_write_run.requested_at >= NOW() - ($3::int * INTERVAL '1 second')
       ) AS has_recent_write_capable_run
     FROM per_session ps
     JOIN sessions s ON s.id = ps.session_id
     LEFT JOIN users u ON u.id = s.created_by
     LEFT JOIN LATERAL (
       SELECT id, status, tool_access_mode, requested_at
       FROM runs
       WHERE session_id = s.id
       ORDER BY requested_at DESC, id DESC
       LIMIT 1
     ) latest_run ON true
     LEFT JOIN LATERAL (
       SELECT id, status, tool_access_mode, requested_at
       FROM runs
       WHERE session_id = s.id
         AND status IN ('queued', 'dispatching', 'running', 'waiting_for_approval', 'cancelling')
       ORDER BY requested_at DESC, id DESC
       LIMIT 1
     ) active_run ON true
     ORDER BY ps.last_activity_at DESC, s.id DESC
     LIMIT 20`,
    [workspaceId, targetId, boundedWindowSeconds]
  );
  return result.rows.map((row) => mapRecentTargetChatActivity(row as RecentTargetChatActivityRow));
}
