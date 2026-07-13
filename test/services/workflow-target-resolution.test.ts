import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { defaultWorkflowDefinitions } from '../../src/store/repository-workflow-defaults.js';
import { repo } from '../../src/store/repository.js';
import {
  resolveWorkflowTarget,
  WorkflowTargetResolutionError
} from '../../src/services/workflow-target-resolution.js';

const originalGetTarget = repo.getTarget;
const originalListTargets = repo.listTargets;

afterEach(() => {
  repo.getTarget = originalGetTarget;
  repo.listTargets = originalListTargets;
});

describe('workflow target resolution', () => {
  it('requires a cluster mention when no structured target reference is supplied', async () => {
    const workflow = defaultWorkflowDefinitions('workspace-1')[0];
    repo.listTargets = async () => ({ items: [] });
    await assert.rejects(
      resolveWorkflowTarget({ workspaceId: 'workspace-1', workflow, inputs: {}, content: 'Triage the cluster.' }),
      (error: unknown) => error instanceof WorkflowTargetResolutionError
        && error.code === 'WORKFLOW_TARGET_MENTION_REQUIRED'
    );
  });

  it('resolves an exact cluster mention to its workspace target', async () => {
    const workflow = defaultWorkflowDefinitions('workspace-1')[0];
    repo.listTargets = async () => ({ items: [{
      id: 'cluster-1', workspaceId: 'workspace-1', targetType: 'kubernetes', name: 'Production',
      status: 'online', metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }] });

    const target = await resolveWorkflowTarget({
      workspaceId: 'workspace-1', workflow, inputs: {}, content: 'Triage @cluster[Production] now.'
    });

    assert.equal(target?.id, 'cluster-1');
  });

  it('accepts an online Kubernetes target from the same workspace', async () => {
    const workflow = defaultWorkflowDefinitions('workspace-1')[0];
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

  it('rejects a structured target that is hidden from the control message', async () => {
    const workflow = defaultWorkflowDefinitions('workspace-1')[0];
    repo.getTarget = async () => ({
      id: 'cluster-1', workspaceId: 'workspace-1', targetType: 'kubernetes', name: 'Production',
      status: 'online', metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    });

    await assert.rejects(
      resolveWorkflowTarget({
        workspaceId: 'workspace-1', workflow, inputs: { targetId: 'cluster-1' }, content: 'Triage the selected cluster.'
      }),
      (error: unknown) => error instanceof WorkflowTargetResolutionError
        && error.code === 'WORKFLOW_TARGET_MENTION_MISMATCH'
    );
  });

  it('rejects offline targets before a run is created', async () => {
    const workflow = defaultWorkflowDefinitions('workspace-1')[0];
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
