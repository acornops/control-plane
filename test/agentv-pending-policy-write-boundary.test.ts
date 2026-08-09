import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { agentVHostPolicyUpdateBlocksWrite } from '../src/controllers/internal-mcp-bridge-controller.js';
import { repo } from '../src/store/repository.js';

afterEach(() => mock.restoreAll());

describe('AgentV pending host policy write boundary', () => {
  it('rechecks pending policy at invocation time for already-issued run tokens', async () => {
    mock.method(repo, 'getVirtualMachine', async () => ({
      pendingAgentAccessPolicy: { accessMode: 'read_write', restartServices: ['worker.service'] }
    }) as never);

    assert.equal(await agentVHostPolicyUpdateBlocksWrite('virtual_machine', 'vm-1', 'write'), true);
    assert.equal(await agentVHostPolicyUpdateBlocksWrite('virtual_machine', 'vm-1', 'read'), false);
    assert.equal(await agentVHostPolicyUpdateBlocksWrite('kubernetes', 'cluster-1', 'write'), false);
  });

  it('allows writes after the host transaction clears pending state', async () => {
    mock.method(repo, 'getVirtualMachine', async () => ({ pendingAgentAccessPolicy: null }) as never);
    assert.equal(await agentVHostPolicyUpdateBlocksWrite('virtual_machine', 'vm-1', 'write'), false);
  });
});
