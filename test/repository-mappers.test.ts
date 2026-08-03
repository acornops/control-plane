import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapCluster,
  mapRun,
  mapRunToolApproval,
  mapSession,
  mapTargetAgentRegistration,
  mapWorkspaceSummary,
  type RunRow,
  type RunToolApprovalRow,
  type SessionRow,
  type TargetAgentRegistrationRow
} from '../src/store/repository-mappers.js';

describe('repository mappers', () => {
  it('reads legacy cluster permission overrides while preferring the canonical enum', () => {
    const legacyCluster = mapCluster({
      id: 'cluster-legacy',
      workspace_id: 'workspace-1',
      target_type: 'kubernetes',
      name: 'Legacy cluster',
      status: 'online',
      namespace_include: [],
      namespace_exclude: [],
      permission_mode_override: null,
      write_confirmation_required_override: false,
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z'
    });
    const canonicalCluster = mapCluster({
      id: 'cluster-canonical',
      workspace_id: 'workspace-1',
      target_type: 'kubernetes',
      name: 'Canonical cluster',
      status: 'online',
      namespace_include: [],
      namespace_exclude: [],
      permission_mode_override: 'read_only',
      write_confirmation_required_override: false,
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z'
    });

    assert.equal(legacyCluster.permissionModeOverride, 'auto_allowed_changes');
    assert.equal(legacyCluster.permissionMode, 'auto_allowed_changes');
    assert.equal(canonicalCluster.permissionModeOverride, 'read_only');
    assert.equal(canonicalCluster.permissionMode, 'read_only');
  });

  it('redacts operational workspace counts for auditor summaries', () => {
    const summary = mapWorkspaceSummary({
      id: 'workspace-1',
      name: 'Workspace',
      created_by: 'owner-1',
      created_at: new Date('2026-05-30T00:00:00.000Z'),
      current_user_role: 'auditor',
      cluster_count: 4,
      member_count: 3
    });

    assert.equal(summary.clusterCount, 0);
    assert.equal(summary.memberCount, 3);
    assert.equal(summary.permissions.read_workspace_data, false);
    assert.equal(summary.permissions.read_audit_log, true);
  });

  it('maps run target scope from the joined target row', () => {
    const row: RunRow = {
      id: 'run-1',
      workspace_id: 'workspace-1',
      target_id: 'target-1',
      target_type: 'virtual_machine',
      session_id: 'session-1',
      message_id: 'message-1',
      tool_access_mode: 'read_only',
      status: 'queued',
      requested_at: '2026-05-24T00:00:00.000Z',
      started_at: null,
      ended_at: null,
      error_code: null,
      error_message: null,
      usage: null,
      assistant_message: null
    };

    const run = mapRun(row);

    assert.equal(run.targetId, 'target-1');
    assert.equal(run.targetType, 'virtual_machine');
    assert.equal(run.clusterId, undefined);
  });

  it('maps run approval target type from the joined target row', () => {
    const row: RunToolApprovalRow = {
      id: 'approval-1',
      run_id: 'run-1',
      workspace_id: 'workspace-1',
      target_id: 'target-1',
      target_type: 'virtual_machine',
      tool_call_id: 'call-1',
      tool_name: 'restart_service',
      summary: 'Restart service default/api.',
      arguments: {},
      status: 'pending',
      execution_status: 'not_started',
      execution_started_at: null,
      execution_finished_at: null,
      tool_result: null,
      tool_result_is_error: null,
      requested_by: null,
      decided_by: null,
      decision: null,
      created_at: '2026-05-24T00:00:00.000Z',
      decided_at: null,
      expires_at: '2026-05-24T00:05:00.000Z'
    };

    const approval = mapRunToolApproval(row);

    assert.equal(approval.targetId, 'target-1');
    assert.equal(approval.targetType, 'virtual_machine');
    assert.equal(approval.clusterId, undefined);
    assert.equal(approval.summary, 'Restart service default/api.');
  });

  it('maps session target scope and only exposes a cluster alias for Kubernetes targets', () => {
    const vmRow: SessionRow = {
      id: 'session-1',
      workspace_id: 'workspace-1',
      target_id: 'target-1',
      target_type: 'virtual_machine',
      created_by: 'user-1',
      title: 'VM session',
      status: 'open',
      created_at: '2026-05-24T00:00:00.000Z',
      updated_at: '2026-05-24T00:00:00.000Z',
      last_message_at: '2026-05-24T00:00:00.000Z',
      expires_at: '2026-05-25T00:00:00.000Z',
      deleted_at: null
    };
    const k8sRow: SessionRow = {
      ...vmRow,
      target_id: 'cluster-1',
      target_type: 'kubernetes',
      title: 'Kubernetes session'
    };

    const vmSession = mapSession(vmRow);
    const k8sSession = mapSession(k8sRow);

    assert.equal(vmSession.targetId, 'target-1');
    assert.equal(vmSession.targetType, 'virtual_machine');
    assert.equal(vmSession.clusterId, undefined);
    assert.equal(k8sSession.targetId, 'cluster-1');
    assert.equal(k8sSession.targetType, 'kubernetes');
    assert.equal(k8sSession.clusterId, 'cluster-1');
  });

  it('maps session owner metadata when the repository query joins users', () => {
    const session = mapSession({
      id: 'session-1',
      workspace_id: 'workspace-1',
      target_id: 'target-1',
      target_type: 'virtual_machine',
      created_by: 'user-1',
      created_by_user_id: 'user-1',
      created_by_display_name: 'Ops User',
      title: 'VM session',
      status: 'open',
      created_at: '2026-05-24T00:00:00.000Z',
      updated_at: '2026-05-24T00:00:00.000Z',
      last_message_at: '2026-05-24T00:00:00.000Z',
      expires_at: '2026-05-25T00:00:00.000Z',
      deleted_at: null
    });

    assert.deepEqual(session.createdByUser, {
      id: 'user-1',
      displayName: 'Ops User'
    });
  });

  it('maps linked issue scope and object labels for automatic sessions', () => {
    const session = mapSession({
      id: 'session-1',
      workspace_id: 'workspace-1',
      target_id: 'cluster-1',
      target_type: 'kubernetes',
      created_by: 'system-auto-triage',
      title: 'CrashLoopBackOff in payments',
      status: 'open',
      origin: 'auto_triage',
      linked_issue_id: 'issue-1',
      linked_issue_lifecycle_version: 1,
      linked_issue_severity: 'warning',
      linked_issue_scope_kind: 'namespace',
      linked_issue_scope_name: 'payments',
      linked_issue_object_kind: 'Deployment',
      linked_issue_object_name: 'api',
      auto_triage_write_mode: 'approval_required',
      auto_triage_effective_tool_mode: 'read_write',
      auto_triage_confirmation_required: true,
      created_at: '2026-05-24T00:00:00.000Z',
      updated_at: '2026-05-24T00:00:00.000Z',
      last_message_at: '2026-05-24T00:00:00.000Z',
      expires_at: '2026-05-25T00:00:00.000Z',
      deleted_at: null
    });

    assert.equal(session.automaticInvestigation?.scopeName, 'payments');
    assert.equal(session.automaticInvestigation?.objectName, 'api');
  });

  it('maps the latest accepted runtime when the repository query joins a run', () => {
    const session = mapSession({
      id: 'session-1',
      workspace_id: 'workspace-1',
      target_id: 'target-1',
      target_type: 'virtual_machine',
      created_by: 'user-1',
      title: 'VM session',
      status: 'open',
      created_at: '2026-05-24T00:00:00.000Z',
      updated_at: '2026-05-24T00:00:00.000Z',
      last_message_at: '2026-05-24T00:00:00.000Z',
      last_llm_provider: 'openai',
      last_llm_model: 'gpt-5.5',
      last_llm_reasoning_effort: 'high',
      expires_at: '2026-05-25T00:00:00.000Z',
      deleted_at: null
    });

    assert.deepEqual(session.lastRuntimeSelection, {
      provider: 'openai',
      model: 'gpt-5.5',
      reasoningEffort: 'high'
    });
  });

  it('maps target agent registration type from the joined target row', () => {
    const row: TargetAgentRegistrationRow = {
      target_id: 'target-1',
      target_type: 'virtual_machine',
      workspace_id: 'workspace-1',
      agent_key_hash: 'hash',
      key_version: 1,
      last_seen_at: null,
      last_heartbeat_at: null,
      last_connection_id: null,
      last_connector_version: null,
      capabilities: null
    };

    const registration = mapTargetAgentRegistration(row);

    assert.equal(registration.targetId, 'target-1');
    assert.equal(registration.targetType, 'virtual_machine');
  });
});
