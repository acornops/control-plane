import assert from 'node:assert/strict';
import { db } from '../../src/infra/db.js';
import { repo } from '../../src/store/repository.js';

export async function insertIssue(
  id: string,
  severity: 'critical' | 'warning' | 'info' = 'warning'
): Promise<void> {
  const severityRank = severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2;
  await db.query(
    `INSERT INTO target_issues (
       id,workspace_id,target_id,target_type,fingerprint,issue_type,status,severity,severity_rank,
       title,summary,scope_kind,scope_name,first_seen_at,last_seen_at,last_observed_snapshot_at
     ) VALUES ($1,'workspace-1','cluster-1','kubernetes',$1,'finding','active',$2,$3,$4,$4,$5,$6,NOW(),NOW(),NOW())`,
    [id, severity, severityRank, `Issue ${id}`, null, null]
  );
}
export async function enableAutoTriage() {
  const settings = await repo.autoTriage.saveTargetAutoTriageSettings({
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    expectedRevision: 0,
    enabled: true,
    minimumSeverity: 'warning',
    writeMode: 'read_only',
    additionalInstructions: '',
    namespaceInclude: [],
    namespaceExclude: [],
    includeClusterScopedIssues: true,
    updatedBy: 'user-1'
  });
  assert.ok(settings);
  return settings;
}
