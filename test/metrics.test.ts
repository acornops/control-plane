import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderControlPlaneMetrics } from '../src/metrics.js';

describe('control-plane metrics', () => {
  it('renders Prometheus-format runtime metrics', () => {
    const payload = renderControlPlaneMetrics();

    assert.match(payload, /# TYPE acornops_control_plane_up gauge/);
    assert.match(payload, /acornops_control_plane_up\{service="acornops-control-plane",node_env="[a-z]+"\} 1/);
    assert.match(payload, /# TYPE acornops_control_plane_memory_bytes gauge/);
    assert.match(payload, /acornops_control_plane_distributed_routing_enabled\{/);
    assert.equal(payload.endsWith('\n'), true);
  });
});
