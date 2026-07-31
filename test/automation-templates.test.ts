import assert from 'node:assert/strict';
import test from 'node:test';

import { STARTER_AUTOMATION_TEMPLATE_VERSION, STARTER_BUNDLE } from '../src/services/automation-templates.js';

test('starter automation ships target-type Agents with fresh-install-ready target tool ceilings', () => {
  assert.equal(STARTER_AUTOMATION_TEMPLATE_VERSION, 7);
  assert.deepEqual(STARTER_BUNDLE.agents.map((agent) => agent.name), [
    'Kubernetes Agent',
    'Virtual Machine Agent'
  ]);

  const kubernetes = STARTER_BUNDLE.agents[0];
  assert.deepEqual(kubernetes.targetConstraints?.targetTypes, ['kubernetes']);
  assert.deepEqual(kubernetes.semanticCapabilityIds, [
    'prompt.resources.read',
    'reports.pdf.generate',
    'target.diagnostics.read',
    'target.remediation.write'
  ]);

  const virtualMachine = STARTER_BUNDLE.agents[1];
  assert.deepEqual(virtualMachine.targetConstraints?.targetTypes, ['virtual_machine']);
  assert.deepEqual(virtualMachine.semanticCapabilityIds, [
    'prompt.resources.read',
    'reports.pdf.generate',
    'target.diagnostics.read'
  ]);

  assert.equal(STARTER_BUNDLE.agents.every((agent) => (
    agent.nativeToolIds?.includes('prompt.resources.read')
      && agent.nativeToolIds.includes('reports.pdf.generate')
  )), true);
});

test('starter Workflows select only the two target-type Agents', () => {
  const workflows = Object.fromEntries(STARTER_BUNDLE.workflows.map((workflow) => [workflow.key, workflow]));
  assert.deepEqual(workflows.kubernetesHealth.agentKeys, ['kubernetesAgent']);
  assert.equal(workflows.kubernetesHealth.restrictionMode, 'inherit');
  assert.deepEqual(workflows.kubernetesHealth.semanticCapabilityIds, []);
  assert.match(workflows.kubernetesHealth.prompt, /without making changes/);
  assert.deepEqual(workflows.virtualMachineHealth.agentKeys, ['virtualMachineAgent']);
  assert.equal(workflows.virtualMachineHealth.restrictionMode, 'inherit');
  assert.deepEqual(workflows.virtualMachineHealth.semanticCapabilityIds, []);
  assert.match(workflows.virtualMachineHealth.prompt, /without making changes/);
  assert.deepEqual(workflows.targetRemediation.agentKeys, ['kubernetesAgent']);
  assert.deepEqual(workflows.managedResponse.agentKeys, ['kubernetesAgent', 'virtualMachineAgent']);
});
