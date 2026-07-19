import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { repo } from '../../src/store/repository.js';
import {
  resolveWorkflowTarget,
  WorkflowTargetResolutionError
} from '../../src/services/workflow-target-resolution.js';
import type { WorkflowDefinitionForAccess } from '../../src/types/workflows.js';

const originalGetTarget = repo.getTarget;
const originalListTargets = repo.listTargets;

afterEach(() => {
  repo.getTarget = originalGetTarget;
  repo.listTargets = originalListTargets;
});

const workflow: WorkflowDefinitionForAccess = {
  id: 'target-diagnostics', workspaceId: 'workspace-1', version: 1,
  origin: { type: 'manual' }, name: 'Target diagnostics', prompt: 'Diagnose the selected target.',
  agentIds: ['diagnostics-agent'], executionMode: 'direct',
  entryAgentId: 'diagnostics-agent', targetConstraints: { targetTypes: ['kubernetes'], targetIds: [] },
  capabilityPolicy: {
    mode: 'read_only', semanticCapabilityIds: ['target.diagnostics.read'], contextGrants: [],
    maxRuntimeSeconds: 300, retentionDays: 7, approvalRequirements: []
  },
  requiredPermissions: ['view_data'], createdBy: 'user-1'
};

describe('workflow target resolution', () => {
  it('requires an exact target when target constraints are present', async () => {
    await assert.rejects(
      resolveWorkflowTarget({ workspaceId: 'workspace-1', workflow, inputs: {}, content: 'Triage the cluster.' }),
      (error: unknown) => error instanceof WorkflowTargetResolutionError
        && error.code === 'WORKFLOW_TARGET_REQUIRED'
    );
  });

  it('accepts an online Kubernetes target from the same workspace', async () => {
    repo.getTarget = async () => ({
      id: 'cluster-1', workspaceId: 'workspace-1', targetType: 'kubernetes', name: 'Production',
      status: 'online', metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    });

    const target = await resolveWorkflowTarget({
      workspaceId: 'workspace-1', workflow, inputs: { targetId: 'cluster-1' },
      content: 'Triage @cluster[Production].', targetId: 'cluster-1', targetType: 'kubernetes'
    });

    assert.equal(target?.id, 'cluster-1');
    assert.equal(target?.targetType, 'kubernetes');
  });

  it('pins the structured target without requiring prompt-name inference', async () => {
    repo.getTarget = async () => ({
      id: 'cluster-1', workspaceId: 'workspace-1', targetType: 'kubernetes', name: 'Production',
      status: 'online', metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    });

    const target = await resolveWorkflowTarget({
      workspaceId: 'workspace-1', workflow, inputs: { targetId: 'cluster-1' }, content: 'Triage the selected cluster.'
    });
    assert.equal(target?.id, 'cluster-1');
  });

  it('rejects offline targets before a run is created', async () => {
    repo.getTarget = async () => ({
      id: 'cluster-1', workspaceId: 'workspace-1', targetType: 'kubernetes', name: 'Production',
      status: 'offline', metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    });

    await assert.rejects(
      resolveWorkflowTarget({ workspaceId: 'workspace-1', workflow, inputs: { targetId: 'cluster-1' } }),
      (error: unknown) => error instanceof WorkflowTargetResolutionError
        && error.code === 'WORKFLOW_TARGET_NOT_READY'
    );
  });
});
