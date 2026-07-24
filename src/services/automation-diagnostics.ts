import type { QueryResultRow } from 'pg';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { setAutomationGauges } from '../metrics.js';
import { listAgentDefinitions } from '../store/repository-agents.js';

type CountMap = Record<string, number>;

export interface AutomationDiagnostics {
  status: 'ok' | 'degraded' | 'disabled';
  runtime: {
    mode: typeof config.AUTOMATION_RUNTIME_MODE;
    workspaceEnabled: boolean;
    workerIntervalMs: number;
  };
  dispatch: {
    byStatus: CountMap;
    oldestPendingAgeSeconds: number;
  };
  runs: {
    workflowByStatus: CountMap;
    byExecutorRole: Record<string, CountMap>;
    byGraphPosition: Record<string, CountMap>;
    active: number;
  };
  schedules: {
    schedulerLagSeconds: number;
  };
  approvals: {
    pending: number;
    oldestPendingAgeSeconds: number;
  };
  templates: {
    byReadiness: CountMap;
    items: Array<{ type: 'agent' | 'workflow'; id: string; name: string; readiness: string; reasons: string[] }>;
  };
  reports: {
    retainedSources: number;
  };
  checkedAt: string;
}

function counts(rows: QueryResultRow[]): CountMap {
  return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count || 0)]));
}

function workspaceEnabled(workspaceId?: string): boolean {
  if (config.AUTOMATION_RUNTIME_MODE === 'on') return true;
  if (config.AUTOMATION_RUNTIME_MODE !== 'canary') return false;
  if (!workspaceId) return true;
  return config.AUTOMATION_CANARY_WORKSPACE_IDS.split(',').map((value) => value.trim()).includes(workspaceId);
}

let nextReadinessRefreshAt = 0;

async function refreshPersistedTemplateReadiness(): Promise<void> {
  if (Date.now() < nextReadinessRefreshAt) return;
  nextReadinessRefreshAt = Date.now() + 60_000;
  const workspaces = await db.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
  for (const workspace of workspaces.rows) {
    const agents = await listAgentDefinitions(workspace.id, { includeInactive: true });
    for (const agent of agents) {
      await db.query(
        `UPDATE agent_definitions SET readiness_status=$3,readiness_reasons=$4,updated_at=updated_at
         WHERE workspace_id=$1 AND id=$2
           AND (readiness_status<>$3 OR readiness_reasons<>$4::jsonb)`,
        [workspace.id, agent.id, agent.readiness.status, JSON.stringify(agent.readiness.reasons)]
      );
    }
  }
}

function scopedWhere(workspaceId: string | undefined, alias = ''): { clause: string; values: unknown[] } {
  return workspaceId
    ? { clause: `WHERE ${alias ? `${alias}.` : ''}workspace_id=$1`, values: [workspaceId] }
    : { clause: '', values: [] };
}

export async function loadAutomationDiagnostics(workspaceId?: string): Promise<AutomationDiagnostics> {
  const outboxScope = scopedWhere(workspaceId);
  const workflowScope = scopedWhere(workspaceId, 'run');
  const approvalScope = scopedWhere(workspaceId);
  const reportScope = scopedWhere(workspaceId);
  const scheduleWorkspaceFilter = workspaceId ? 'AND workspace_id=$1' : '';
  const templateWorkspaceFilter = workspaceId ? 'WHERE workspace_id=$1' : '';
  const values = workspaceId ? [workspaceId] : [];

  const [outbox, oldest, workflowRuns, approvals, schedules, agents, workflows, reports] = await Promise.all([
    db.query<QueryResultRow>(
      `SELECT status,COUNT(*) AS count FROM automation_dispatch_outbox ${outboxScope.clause} GROUP BY status`,
      outboxScope.values
    ),
    db.query<QueryResultRow>(
      `SELECT COALESCE(EXTRACT(EPOCH FROM NOW()-MIN(created_at)),0) AS age
       FROM automation_dispatch_outbox ${outboxScope.clause}${outboxScope.clause ? ' AND' : ' WHERE'} status IN ('pending','failed','claimed')`,
      outboxScope.values
    ),
    db.query<QueryResultRow>(
      `SELECT run.status,run.executor_role,
              CASE WHEN run.parent_run_id IS NULL THEN 'root' ELSE 'child' END AS graph_position,
              COUNT(*) AS count
       FROM workflow_runs run ${workflowScope.clause}
       GROUP BY run.status,run.executor_role,graph_position`,
      workflowScope.values
    ),
    db.query<QueryResultRow>(
      `SELECT COUNT(*) AS count,COALESCE(EXTRACT(EPOCH FROM NOW()-MIN(created_at)),0) AS oldest_age
       FROM workflow_run_approvals ${approvalScope.clause}${approvalScope.clause ? ' AND' : ' WHERE'} status='pending'`,
      approvalScope.values
    ),
    db.query<QueryResultRow>(
      `SELECT COALESCE(MAX(EXTRACT(EPOCH FROM NOW()-next_run_at)),0) AS lag
       FROM workflow_schedules
       WHERE status='enabled' AND next_run_at<NOW() ${scheduleWorkspaceFilter}`,
      values
    ),
    db.query<QueryResultRow>(
      `SELECT id,name,readiness_status,readiness_reasons FROM agent_definitions
       ${templateWorkspaceFilter}
       ORDER BY id`,
      values
    ),
    db.query<QueryResultRow>(
      `SELECT id,name,readiness_status,readiness_reasons FROM workflow_definitions ${templateWorkspaceFilter} ORDER BY id`,
      values
    ),
    db.query<QueryResultRow>(
      `SELECT COUNT(*) AS count FROM workflow_reports ${reportScope.clause}`, reportScope.values
    )
  ]);

  const byOutboxStatus = counts(outbox.rows);
  const workflowByStatus: CountMap = {};
  const byExecutorRole: Record<string, CountMap> = {};
  const byGraphPosition: Record<string, CountMap> = {};
  for (const row of workflowRuns.rows) {
    const status = String(row.status);
    const count = Number(row.count || 0);
    const executorRole = String(row.executor_role);
    const graphPosition = String(row.graph_position);
    workflowByStatus[status] = (workflowByStatus[status] || 0) + count;
    byExecutorRole[executorRole] ||= {};
    byExecutorRole[executorRole][status] = (byExecutorRole[executorRole][status] || 0) + count;
    byGraphPosition[graphPosition] ||= {};
    byGraphPosition[graphPosition][status] = (byGraphPosition[graphPosition][status] || 0) + count;
  }
  const templates = [
    ...agents.rows.map((row) => ({ type: 'agent' as const, id: row.id, name: row.name,
      readiness: row.readiness_status, reasons: row.readiness_reasons || [] })),
    ...workflows.rows.map((row) => ({ type: 'workflow' as const, id: row.id, name: row.name,
      readiness: row.readiness_status, reasons: row.readiness_reasons || [] }))
  ];
  const byReadiness: CountMap = {};
  for (const template of templates) byReadiness[template.readiness] = (byReadiness[template.readiness] || 0) + 1;
  const oldestPendingAgeSeconds = Math.max(0, Number(oldest.rows[0]?.age || 0));
  const schedulerLagSeconds = Math.max(0, Number(schedules.rows[0]?.lag || 0));
  const active = ['queued', 'dispatching', 'running', 'waiting_for_approval', 'needs_review']
    .reduce((total, status) => total + (workflowByStatus[status] || 0), 0);
  const enabled = workspaceEnabled(workspaceId);
  const degraded = (byOutboxStatus.needs_review || 0) > 0 || oldestPendingAgeSeconds > 30 || schedulerLagSeconds > 60;

  return {
    status: !enabled ? 'disabled' : degraded ? 'degraded' : 'ok',
    runtime: { mode: config.AUTOMATION_RUNTIME_MODE, workspaceEnabled: enabled, workerIntervalMs: config.AUTOMATION_WORKER_INTERVAL_MS },
    dispatch: { byStatus: byOutboxStatus, oldestPendingAgeSeconds },
    runs: { workflowByStatus, byExecutorRole, byGraphPosition, active },
    schedules: { schedulerLagSeconds },
    approvals: {
      pending: Number(approvals.rows[0]?.count || 0),
      oldestPendingAgeSeconds: Math.max(0, Number(approvals.rows[0]?.oldest_age || 0))
    },
    templates: { byReadiness, items: templates },
    reports: { retainedSources: Number(reports.rows[0]?.count || 0) },
    checkedAt: new Date().toISOString()
  };
}

export async function refreshAutomationMetricsSnapshot(): Promise<void> {
  await refreshPersistedTemplateReadiness();
  const diagnostics = await loadAutomationDiagnostics();
  const gauges: Record<string, number> = {
    'outbox_oldest_pending_age_seconds:all': diagnostics.dispatch.oldestPendingAgeSeconds,
    'scheduler_lag_seconds:all': diagnostics.schedules.schedulerLagSeconds,
    'active_runs:all': diagnostics.runs.active,
    'approval_waiting:all': diagnostics.approvals.pending,
    'approval_oldest_pending_age_seconds:all': diagnostics.approvals.oldestPendingAgeSeconds,
    'reports:retained_sources': diagnostics.reports.retainedSources
  };
  for (const [status, value] of Object.entries(diagnostics.dispatch.byStatus)) gauges[`outbox:${status}`] = value;
  for (const [status, value] of Object.entries(diagnostics.templates.byReadiness)) gauges[`template_readiness:${status}`] = value;
  for (const [status, value] of Object.entries(diagnostics.runs.workflowByStatus)) gauges[`workflow_runs:${status}`] = value;
  for (const [role, statuses] of Object.entries(diagnostics.runs.byExecutorRole)) {
    for (const [status, value] of Object.entries(statuses)) gauges[`workflow_runs:${role}:${status}`] = value;
  }
  for (const [position, statuses] of Object.entries(diagnostics.runs.byGraphPosition)) {
    for (const [status, value] of Object.entries(statuses)) gauges[`workflow_runs:${position}:${status}`] = value;
  }
  setAutomationGauges(gauges);
}
