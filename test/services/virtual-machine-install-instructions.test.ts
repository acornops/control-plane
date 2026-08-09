import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildVirtualMachineInstallInstructions } from '../../src/services/virtual-machine-install-instructions.js';

describe('virtual machine install instructions', () => {
  it('builds an exact-version executable bootstrap command with a shell-quoted enrollment token', () => {
    const instructions = buildVirtualMachineInstallInstructions({
      platformUrl: 'https://control-plane.example.test',
      targetId: 'vm-target-1',
      enrollmentToken: "aev-'$(must-not-expand)",
      enrollmentExpiresAt: '2026-08-09T12:15:00.000Z',
      releaseVersion: '0.0.1-experimental.6',
      releaseBaseUrl: 'https://artifacts.example.test/acornops/'
    });

    assert.equal(instructions.releaseVersion, '0.0.1-experimental.6');
    assert.equal(instructions.bootstrapUrl, 'https://artifacts.example.test/acornops/v0.0.1-experimental.6/install-agentv.sh');
    assert.match(instructions.command, /^set -o pipefail; curl -fsSL --proto '=https' --proto-redir '=https' /);
    assert.match(instructions.command, /--platform-url 'https:\/\/control-plane\.example\.test'/);
    assert.match(instructions.command, /--enrollment-token 'aev-'"'"'\$\(must-not-expand\)'/);
    assert.doesNotMatch(instructions.command, /--agent-key/);
    assert.doesNotMatch(instructions.command, /```|Install the AcornOps|github\.com/);
    assert.equal(instructions.enrollmentExpiresAt, '2026-08-09T12:15:00.000Z');
    assert.ok(instructions.warnings.some((warning) => warning.includes('one-use AgentV enrollment token')));
  });

  it('rejects an impossible replacement command without enrollment', () => {
    assert.throws(() => buildVirtualMachineInstallInstructions({
      platformUrl: 'https://api.example.test',
      targetId: 'vm-1',
      releaseVersion: '0.0.1-experimental.6',
      releaseBaseUrl: 'https://artifacts.example.test/agentv',
      replaceCredential: true
    }), /require an enrollment token/);
  });

  it('labels a host policy command without changing its bootstrap interface', () => {
    const instructions = buildVirtualMachineInstallInstructions({
      platformUrl: 'https://api.example.test',
      targetId: 'vm-1',
      releaseVersion: '0.0.1-experimental.6',
      releaseBaseUrl: 'https://artifacts.example.test/agentv',
      enrollmentToken: 'one-use-token',
      replaceCredential: true,
      policyUpdate: true
    });
    assert.match(instructions.command, /--replace-credential$/);
    assert.ok(instructions.warnings.some((warning) => warning.includes('root-owned service allowlist')));
    assert.doesNotMatch(instructions.command, /policy|restartServices/);
  });
});
