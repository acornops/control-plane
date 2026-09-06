/**
 * Suspension ordering uses the database admission clock, not requestedAt display
 * metadata. Missing legacy reservations predate every known suspension: accepting
 * an application timestamp here could revive work after a rapid restore.
 * Only static, repository-owned SQL aliases are accepted.
 */
export function executionAdmissionTimeSql(runAlias: 'r' | 'runs' | 'workflow_runs'): string {
  return `COALESCE((SELECT admission.created_at FROM workspace_run_reservations admission
    WHERE admission.run_id=${runAlias}.id AND admission.workspace_id=${runAlias}.workspace_id),
    '-infinity'::timestamptz)`;
}
