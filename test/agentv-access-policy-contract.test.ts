import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAgentVAccessPolicy } from '../src/types/agentv-access-policy.js';
import {
  registerVirtualMachineSchema,
  updateAgentVAccessPolicySchema,
  updateVirtualMachineSchema
} from '../src/types/contracts.js';

describe('AgentV access policy contract', () => {
  it('defaults omitted policy to read-only', () => {
    const parsed = registerVirtualMachineSchema.parse({ name: 'production-vm' });
    assert.equal(parsed.agentAccessMode, 'read_only');
    assert.deepEqual(parsed.restartServices, []);
  });

  it('accepts only unique exact non-AgentV services for read-write access', () => {
    const parsed = registerVirtualMachineSchema.parse({
      name: 'production-vm',
      agentAccessMode: 'read_write',
      restartServices: ['nginx.service', 'postgresql@16-main.service']
    });
    assert.deepEqual(parsed.restartServices, ['nginx.service', 'postgresql@16-main.service']);

    for (const restartServices of [
      [],
      ['nginx*'],
      ['nginx.service', 'nginx.service'],
      ['acornops-agentv.service'],
      ['acornops-agentv-install-recovery.service']
    ]) {
      assert.equal(registerVirtualMachineSchema.safeParse({
        name: 'production-vm', agentAccessMode: 'read_write', restartServices
      }).success, false);
    }
  });

  it('rejects service allowlists attached to read-only access', () => {
    assert.equal(registerVirtualMachineSchema.safeParse({
      name: 'production-vm', agentAccessMode: 'read_only', restartServices: ['nginx.service']
    }).success, false);
  });

  it('validates host policy updates with the same exact-unit boundary', () => {
    assert.deepEqual(updateAgentVAccessPolicySchema.parse({
      agentAccessMode: 'read_write', restartServices: ['worker.service']
    }), { agentAccessMode: 'read_write', restartServices: ['worker.service'] });
    assert.equal(updateAgentVAccessPolicySchema.safeParse({
      agentAccessMode: 'read_write', restartServices: ['*.service']
    }).success, false);
    assert.equal(updateAgentVAccessPolicySchema.safeParse({
      agentAccessMode: 'read_only', restartServices: [], unexpected: true
    }).success, false);
  });

  it('rejects unexpected stored policy fields', () => {
    assert.equal(parseAgentVAccessPolicy({ accessMode: 'read_only', restartServices: [], unexpected: true }), null);
  });

  it('accepts only canonical VM run permission overrides on update', () => {
    assert.equal(updateVirtualMachineSchema.parse({ permissionModeOverride: 'read_only' }).permissionModeOverride, 'read_only');
    assert.equal(updateVirtualMachineSchema.parse({ permissionModeOverride: null }).permissionModeOverride, null);
    assert.throws(() => updateVirtualMachineSchema.parse({ permissionModeOverride: 'allow_everything' }));
  });
});
