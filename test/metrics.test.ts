import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  incrementKnowledgeBankCheckpointOutcome,
  incrementKnowledgeBankRetrieval,
  observeKnowledgeBankCheckpointDurationMs,
  recordKnowledgeBankCheckpointPatchCount,
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

  it('renders Knowledge Bank operational metrics without high-cardinality labels', () => {
    incrementKnowledgeBankRetrieval('hit');
    incrementKnowledgeBankCheckpointOutcome('skipped', 'ai_settings_missing');
    observeKnowledgeBankCheckpointDurationMs('completed', 1200);
    recordKnowledgeBankCheckpointPatchCount('applied', 2);

    const payload = renderControlPlaneMetrics();

    assert.match(payload, /control_plane_knowledge_bank_retrievals_total\{[^}]*outcome="hit"[^}]*\}/);
    assert.match(payload, /control_plane_knowledge_bank_checkpoint_outcomes_total\{[^}]*status="skipped",reason="ai_settings_missing"[^}]*\}/);
    assert.match(payload, /control_plane_knowledge_bank_checkpoint_duration_ms_bucket\{[^}]*status="completed",le="5000"[^}]*\}/);
    assert.match(payload, /control_plane_knowledge_bank_checkpoint_patches_total\{[^}]*status="applied"[^}]*\} 2/);
  });
});
