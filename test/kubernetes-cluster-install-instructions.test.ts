import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAgentInstallInstructions,
  parseAgentAccessMode
} from '../src/controllers/workspaces/kubernetes-cluster-request-utils.js';
import { config } from '../src/config.js';
import { registerClusterSchema } from '../src/types/contracts.js';
import type { KubernetesCluster } from '../src/types/domain.js';

const cluster: KubernetesCluster = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  name: 'payments-prod',
  status: 'unknown',
  namespaceInclude: ['payments', 'shared'],
  namespaceExclude: ['sandbox'],
  writeConfirmationPolicy: {
    effectiveRequired: true,
    overrideRequired: null,
    source: 'deployment_default'
  },
  createdAt: '2026-06-30T00:00:00.000Z',
  updatedAt: '2026-06-30T00:00:00.000Z'
};

const mutableConfig = config as typeof config & { AGENT_HELM_CHART_VERSION?: string };

describe('Kubernetes cluster install instructions', () => {
  it('keeps generated install commands read-only by default', () => {
    const instructions = buildAgentInstallInstructions(cluster, 'agent-key');

    assert.doesNotMatch(instructions.command, /rbac\.write\.enabled=true/);
    assert.match(instructions.command, /--devel/);
    assert.doesNotMatch(instructions.command, /--version/);
    assert.match(instructions.command, /--set-string config\.agentKey='agent-key'/);
    assert.match(instructions.command, /--set-json namespaceScope\.include='\["payments","shared"\]'/);
  });

  it('pins the chart only when a version is configured', () => {
    const previousVersion = mutableConfig.AGENT_HELM_CHART_VERSION;
    mutableConfig.AGENT_HELM_CHART_VERSION = '0.0.1-experimental.4';
    try {
      const instructions = buildAgentInstallInstructions(cluster, 'agent-key');

      assert.match(instructions.command, /--version '0\.0\.1-experimental\.4'/);
      assert.doesNotMatch(instructions.command, /--devel/);
    } finally {
      mutableConfig.AGENT_HELM_CHART_VERSION = previousVersion;
    }
  });

  it('adds the chart write RBAC flag for read-write installs', () => {
    const instructions = buildAgentInstallInstructions(cluster, 'agent-key', 'read_write');

    assert.match(instructions.command, /--set rbac\.write\.enabled=true/);
  });

  it('parses unknown access modes as read-only', () => {
    assert.equal(parseAgentAccessMode('read_write'), 'read_write');
    assert.equal(parseAgentAccessMode('read_only'), 'read_only');
    assert.equal(parseAgentAccessMode('admin'), 'read_only');
    assert.equal(parseAgentAccessMode(undefined), 'read_only');
  });

  it('preserves agent access mode through registration body validation', () => {
    const parsed = registerClusterSchema.parse({
      name: 'payments-prod',
      agentAccessMode: 'read_write',
      namespaceInclude: ['payments'],
      namespaceExclude: ['sandbox']
    });

    assert.equal(parsed.agentAccessMode, 'read_write');
  });

  it('rejects namespace policy values AgentK cannot safely enforce', () => {
    assert.equal(registerClusterSchema.safeParse({
      name: 'invalid', namespaceInclude: ['INVALID']
    }).success, false);
    assert.equal(registerClusterSchema.safeParse({
      name: 'duplicate', namespaceInclude: ['payments', 'payments']
    }).success, false);
  });

  it('lets controller defaulting handle unknown registration access modes', () => {
    const parsed = registerClusterSchema.parse({
      name: 'payments-prod',
      agentAccessMode: 'admin'
    });

    assert.equal(parseAgentAccessMode(parsed.agentAccessMode), 'read_only');
  });
});
