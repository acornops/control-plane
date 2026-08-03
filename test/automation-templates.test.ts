import assert from 'node:assert/strict';
import test from 'node:test';

import { STARTER_BUNDLE } from '../src/services/automation-templates.js';
import { templateRecordReferencesById } from '../src/store/repository-automation-templates.js';

test('starter automation ships target-capable Agents without target bindings', () => {
  assert.deepEqual(STARTER_BUNDLE.agents.map((agent) => agent.name), [
    'Kubernetes Agent',
    'Virtual Machine Agent'
  ]);

  const kubernetes = STARTER_BUNDLE.agents[0];
  assert.equal('targetConstraints' in kubernetes, false);
  assert.deepEqual(kubernetes.semanticCapabilityIds, [
    'documents.create',
    'infrastructure.diagnostics.read',
    'infrastructure.remediation.write'
  ]);

  const virtualMachine = STARTER_BUNDLE.agents[1];
  assert.equal('targetConstraints' in virtualMachine, false);
  assert.deepEqual(virtualMachine.semanticCapabilityIds, [
    'documents.create',
    'infrastructure.diagnostics.read'
  ]);

  assert.equal(STARTER_BUNDLE.agents.every((agent) => (
    agent.nativeToolIds?.includes('documents.create')
  )), true);
});

test('starter Workflows select the intended specialist Agents without target bindings', () => {
  const workflows = Object.fromEntries(STARTER_BUNDLE.workflows.map((workflow) => [workflow.key, workflow]));
  assert.deepEqual(workflows.kubernetesHealth.agentKeys, ['kubernetesAgent']);
  assert.match(workflows.kubernetesHealth.prompt, /without making changes/);
  assert.deepEqual(workflows.virtualMachineHealth.agentKeys, ['virtualMachineAgent']);
  assert.match(workflows.virtualMachineHealth.prompt, /without making changes/);
  assert.deepEqual(workflows.infrastructureRemediation.agentKeys, ['kubernetesAgent']);
  assert.deepEqual(workflows.managedResponse.agentKeys, ['kubernetesAgent', 'virtualMachineAgent']);
});

test('template record references expose stable Agent provenance only after installation completes', () => {
  const references = templateRecordReferencesById([
    {
      workspaceId: 'workspace-1',
      templateId: 'acornops-starter',
      state: 'complete',
      installedBy: 'user-1',
      installedAt: '2026-08-03T00:00:00.000Z',
      recordIds: {
        'agent:kubernetesAgent': 'agent-kubernetes',
        'agent:virtualMachineAgent': 'agent-vm'
      }
    },
    {
      workspaceId: 'workspace-1',
      templateId: 'pending-template',
      state: 'pending',
      installedBy: 'user-1',
      installedAt: '2026-08-03T00:00:00.000Z',
      recordIds: { 'agent:pending': 'agent-pending' }
    }
  ]);

  assert.deepEqual(references.get('agent-kubernetes'), {
    templateId: 'acornops-starter',
    recordKey: 'agent:kubernetesAgent'
  });
  assert.deepEqual(references.get('agent-vm'), {
    templateId: 'acornops-starter',
    recordKey: 'agent:virtualMachineAgent'
  });
  assert.equal(references.has('agent-pending'), false);
});
