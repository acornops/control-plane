import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  incrementApprovalInboxQuery,
  incrementAgentHandoff,
  incrementAutomationDefinitionMutation,
  incrementAutomationTemplateSeed,
  incrementTargetInsightsCheckpointOutcome,
  incrementTargetInsightsRetrieval,
  incrementWorkflowRoutingOutcome,
  observeApprovalInboxQueryDurationMs,
  observeTargetInsightsCheckpointDurationMs,
  observeWorkflowCapabilityPreview,
  observeWorkflowDelegationOutcome,
  observeToolResultArtifactBytes,
  observeWorkspaceNativeToolCall,
  recordTargetInsightsCheckpointPatchCount,
  renderControlPlaneMetrics
} from '../src/metrics.js';

describe('control-plane metrics', () => {
  it('renders Prometheus-format runtime metrics', () => {
    const payload = renderControlPlaneMetrics();

    assert.match(payload, /# TYPE acornops_control_plane_up gauge/);
    assert.match(payload, /acornops_control_plane_up\{service="acornops-control-plane",node_env="[a-z]+"\} 1/);
    assert.match(payload, /# TYPE acornops_control_plane_memory_bytes gauge/);
    assert.match(payload, /acornops_control_plane_distributed_routing_enabled\{/);
    assert.equal(payload.endsWith('\n'), true);
  });

  it('renders Target Insights operational metrics without high-cardinality labels', () => {
    incrementTargetInsightsRetrieval('hit');
    incrementTargetInsightsCheckpointOutcome('skipped', 'ai_settings_missing');
    observeTargetInsightsCheckpointDurationMs('completed', 1200);
    recordTargetInsightsCheckpointPatchCount('applied', 2);

    const payload = renderControlPlaneMetrics();

    assert.match(payload, /control_plane_target_insights_retrievals_total\{[^}]*outcome="hit"[^}]*\}/);
    assert.match(payload, /control_plane_target_insights_checkpoint_outcomes_total\{[^}]*status="skipped",reason="ai_settings_missing"[^}]*\}/);
    assert.match(payload, /control_plane_target_insights_checkpoint_duration_ms_bucket\{[^}]*status="completed",le="5000"[^}]*\}/);
    assert.match(payload, /control_plane_target_insights_checkpoint_patches_total\{[^}]*status="applied"[^}]*\} 2/);
  });

  it('renders approval inbox query outcomes and duration without workspace labels', () => {
    incrementApprovalInboxQuery('pending', 'success');
    observeApprovalInboxQueryDurationMs('pending', 'success', 75);

    const payload = renderControlPlaneMetrics();

    assert.match(payload, /control_plane_approval_inbox_queries_total\{[^}]*status="pending",outcome="success"[^}]*\}/);
    assert.match(payload, /control_plane_approval_inbox_query_duration_ms_bucket\{[^}]*status="pending",outcome="success",le="100"[^}]*\}/);
    assert.doesNotMatch(payload, /workspace[_-]?id=/i);
  });

  it('renders low-cardinality automation definition mutation outcomes', () => {
    incrementAutomationDefinitionMutation('agent', 'configuration', 'success');
    incrementAutomationDefinitionMutation('workflow', 'duplication', 'rejected');

    const payload = renderControlPlaneMetrics();

    assert.match(payload, /control_plane_automation_definition_mutations_total\{[^}]*resource="agent",operation="configuration",outcome="success"[^}]*\} 1/);
    assert.match(payload, /control_plane_automation_definition_mutations_total\{[^}]*resource="workflow",operation="duplication",outcome="rejected"[^}]*\} 1/);
    assert.doesNotMatch(payload, /control_plane_automation_definition_mutations_total\{[^}]*workspace/);
  });

  it('renders bounded starter automation seed outcomes', () => {
    incrementAutomationTemplateSeed('acornops-starter', 'success');
    incrementAutomationTemplateSeed('acornops-starter', 'failure');

    const payload = renderControlPlaneMetrics();

    assert.match(payload, /control_plane_automation_template_seed_total\{[^}]*template_id="acornops-starter",outcome="success"[^}]*\} 1/);
    assert.match(payload, /control_plane_automation_template_seed_total\{[^}]*template_id="acornops-starter",outcome="failure"[^}]*\} 1/);
    assert.doesNotMatch(payload, /control_plane_automation_template_seed_total\{[^}]*(workspace|record)_id=/);
  });

  it('renders bounded Agent handoff outcomes without identity labels', () => {
    incrementAgentHandoff('confirmed');
    incrementAgentHandoff('forbidden');

    const payload = renderControlPlaneMetrics();

    assert.match(payload, /control_plane_agent_handoffs_total\{[^}]*outcome="confirmed"[^}]*\} 1/);
    assert.match(payload, /control_plane_agent_handoffs_total\{[^}]*outcome="forbidden"[^}]*\} 1/);
    assert.doesNotMatch(payload, /control_plane_agent_handoffs_total\{[^}]*(agent|session|workspace)_id=/);
  });

  it('renders low-cardinality workflow routing and coordination latency', () => {
    incrementWorkflowRoutingOutcome('direct', 'success');
    incrementWorkflowRoutingOutcome('coordinated', 'failure');
    observeWorkflowDelegationOutcome('selected', 42);

    const payload = renderControlPlaneMetrics();

    assert.match(payload, /control_plane_workflow_routing_total\{[^}]*mode="direct",outcome="success"[^}]*\} 1/);
    assert.match(payload, /control_plane_workflow_routing_total\{[^}]*mode="coordinated",outcome="failure"[^}]*\} 1/);
    assert.match(payload, /control_plane_workflow_delegation_total\{[^}]*outcome="selected"[^}]*\} 1/);
    assert.match(payload, /control_plane_workflow_delegation_duration_ms_bucket\{[^}]*outcome="selected",le="50"[^}]*\} 1/);
    assert.doesNotMatch(payload, /control_plane_workflow_(?:routing|delegation)[^{]*\{[^}]*(?:agent|workspace|workflow)_id=/);
  });

  it('renders bounded workflow capability preview outcomes and latency', () => {
    observeWorkflowCapabilityPreview('ready', 42);
    observeWorkflowCapabilityPreview('blocked', 120);

    const payload = renderControlPlaneMetrics();

    assert.match(payload, /control_plane_workflow_capability_preview_total\{[^}]*status="ready"[^}]*\} 1/);
    assert.match(payload, /control_plane_workflow_capability_preview_total\{[^}]*status="blocked"[^}]*\} 1/);
    assert.match(payload, /control_plane_workflow_capability_preview_duration_ms_bucket\{[^}]*status="ready",le="50"[^}]*\} 1/);
    assert.doesNotMatch(payload, /control_plane_workflow_capability_preview[^\n]*\{[^}]*(?:target|workspace|workflow)_id=/);
  });

  it('renders artifact sizes as a complete Prometheus histogram', () => {
    observeToolResultArtifactBytes('uncompressed', 2048);
    const payload = renderControlPlaneMetrics();

    assert.match(payload, /# TYPE control_plane_tool_result_artifact_bytes histogram/);
    assert.match(payload, /control_plane_tool_result_artifact_bytes_bucket\{[^}]*view="uncompressed",le="16384"[^}]*\} 1/);
    assert.match(payload, /control_plane_tool_result_artifact_bytes_sum\{[^}]*view="uncompressed"[^}]*\} 2048/);
    assert.match(payload, /control_plane_tool_result_artifact_bytes_count\{[^}]*view="uncompressed"[^}]*\} 1/);
  });

  it('renders workspace-native outcomes with canonical bounded IDs and no correlation labels', () => {
    observeWorkspaceNativeToolCall('reports.pdf.generate', 'success', 42);
    observeWorkspaceNativeToolCall('unknown.dynamic.tool', 'failure', 75);
    const payload = renderControlPlaneMetrics();

    assert.match(payload, /control_plane_workspace_native_tool_calls_total\{[^}]*tool_id="reports\.pdf\.generate",outcome="success"[^}]*\} 1/);
    assert.match(payload, /control_plane_workspace_native_tool_calls_total\{[^}]*tool_id="other",outcome="failure"[^}]*\} 1/);
    assert.match(payload, /control_plane_workspace_native_tool_call_duration_ms_bucket\{[^}]*tool_id="reports\.pdf\.generate",outcome="success",le="50"[^}]*\} 1/);
    assert.doesNotMatch(payload, /control_plane_workspace_native_tool_[^\n]*\{[^}]*(?:run|workspace|tool_call)_id=/);
  });
});
