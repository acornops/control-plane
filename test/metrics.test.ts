import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  incrementApprovalInboxQuery,
  incrementTargetInsightsCheckpointOutcome,
  incrementTargetInsightsRetrieval,
  observeApprovalInboxQueryDurationMs,
  observeTargetInsightsCheckpointDurationMs,
  observeToolResultArtifactBytes,
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

  it('renders artifact sizes as a complete Prometheus histogram', () => {
    observeToolResultArtifactBytes('uncompressed', 2048);
    const payload = renderControlPlaneMetrics();

    assert.match(payload, /# TYPE control_plane_tool_result_artifact_bytes histogram/);
    assert.match(payload, /control_plane_tool_result_artifact_bytes_bucket\{[^}]*view="uncompressed",le="16384"[^}]*\} 1/);
    assert.match(payload, /control_plane_tool_result_artifact_bytes_sum\{[^}]*view="uncompressed"[^}]*\} 2048/);
    assert.match(payload, /control_plane_tool_result_artifact_bytes_count\{[^}]*view="uncompressed"[^}]*\} 1/);
  });
});
