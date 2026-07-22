import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildVirtualMachineInstallInstructions } from '../../src/services/virtual-machine-install-instructions.js';

describe('virtual machine install instructions', () => {
  it('uses the configured platform URL and a literal heredoc for credentials', () => {
    const instructions = buildVirtualMachineInstallInstructions({
      platformUrl: 'https://control-plane.example.test',
      targetId: 'vm-target-1',
      agentKey: 'secret-$(must-not-expand)'
    });

    assert.match(instructions, /<<'EOF'/);
    assert.match(instructions, /ACORNOPS_AGENT_PLATFORM_URL=https:\/\/control-plane\.example\.test/);
    assert.match(instructions, /ACORNOPS_AGENT_KEY=secret-\$\(must-not-expand\)/);
    assert.doesNotMatch(instructions, /api\.acornops\.dev/);
  });
});
