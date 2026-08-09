import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  createVirtualMachineAgentEnrollment,
  getVirtualMachineInstallInstructions,
  registerVirtualMachine,
} from '../src/controllers/workspaces/virtual-machine-controller.js';
import { repo } from '../src/store/repository.js';
import type { TargetSummary, VirtualMachineTarget, WorkspaceAuditEventInput } from '../src/types/domain.js';

const originals = {
  addVirtualMachine: repo.addVirtualMachine,
  deleteVirtualMachine: repo.deleteVirtualMachine,
  enqueueWebhookOutboxEvent: repo.enqueueWebhookOutboxEvent,
  getTarget: repo.getTarget,
  getTargetAgentRegistration: repo.getTargetAgentRegistration,
  getWorkspaceRole: repo.getWorkspaceRole,
  insertWorkspaceAuditEvent: repo.insertWorkspaceAuditEvent,
};
const originalCreateAgentVEnrollment = repo.agentv.createAgentVEnrollment;

afterEach(() => {
  Object.assign(repo, originals);
  repo.agentv.createAgentVEnrollment = originalCreateAgentVEnrollment;
  mock.restoreAll();
});

const virtualMachine: VirtualMachineTarget = {
  id: '5d2d65e5-68ce-4f88-b6b5-45ef48f00101',
  workspaceId: 'workspace-1',
  name: 'production-vm',
  status: 'unknown',
  hostname: 'production-vm.example.test',
  osFamily: 'linux',
  serviceManager: 'systemd',
  allowedLogSources: ['acornops-agentv.service'],
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
};

const target: TargetSummary = {
  id: virtualMachine.id,
  workspaceId: virtualMachine.workspaceId,
  targetType: 'virtual_machine',
  name: virtualMachine.name,
  status: virtualMachine.status,
  metadata: {},
  createdAt: virtualMachine.createdAt,
  updatedAt: virtualMachine.updatedAt,
};

function request(body: Record<string, unknown> = {}) {
  return {
    auth: { userId: 'user-1', credential: { type: 'session', sessionId: 'session-1' } },
    params: { workspaceId: 'workspace-1', vmId: virtualMachine.id },
    body,
    query: {},
  };
}

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}

function assertStructuredInstructions(body: unknown): string {
  const payload = body as {
    agentKey?: string;
    installInstructions: { command: string; releaseVersion: string; bootstrapUrl: string; warnings: string[]; enrollmentExpiresAt?: string };
  };
  assert.equal(payload.installInstructions.releaseVersion, '0.0.1-experimental.6');
  assert.equal(
    payload.installInstructions.bootstrapUrl,
    'https://github.com/acornops/agentv/releases/download/v0.0.1-experimental.6/install-agentv.sh'
  );
  assert.match(payload.installInstructions.command, /^set -o pipefail; curl -fsSL --proto '=https' --proto-redir '=https' /);
  assert.equal(payload.agentKey, undefined);
  assert.match(payload.installInstructions.command, /--enrollment-token 'aev_/);
  assert.doesNotMatch(payload.installInstructions.command, /--agent-key/);
  assert.ok(payload.installInstructions.warnings.some((warning) => warning.includes('one-use AgentV enrollment token')));
  return payload.installInstructions.command;
}

describe('virtual machine onboarding instructions', () => {
  it('returns structured registration instructions without persisting the key or command in audit data', async () => {
    const audits: WorkspaceAuditEventInput[] = [];
    let storedEnrollment: { tokenHash: string } | undefined;
    repo.getWorkspaceRole = async () => 'owner';
    repo.addVirtualMachine = async () => virtualMachine;
    repo.agentv.createAgentVEnrollment = async (input) => { storedEnrollment = input; return true; };
    repo.enqueueWebhookOutboxEvent = async () => null;
    repo.insertWorkspaceAuditEvent = async (event) => { audits.push(event); };
    const res = response();

    await registerVirtualMachine(request({ name: virtualMachine.name }) as never, res as never, (error?: unknown) => {
      if (error) throw error;
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    const command = assertStructuredInstructions(res.body);
    assert.doesNotMatch(command, /--replace-credential/);
    assert.match(storedEnrollment?.tokenHash || '', /^[0-9a-f]{32}:[0-9a-f]{128}$/);
    assert.ok(!storedEnrollment?.tokenHash.includes('aev_'));
    const auditJson = JSON.stringify(audits);
    assert.ok(!auditJson.includes(command));
    assert.ok(!auditJson.includes('install-agentv.sh'));
  });

  it('returns structured credential-replacement instructions without persisting the command in audit data', async () => {
    const audits: WorkspaceAuditEventInput[] = [];
    repo.getWorkspaceRole = async () => 'owner';
    repo.getTarget = async () => target;
    repo.getTargetAgentRegistration = async () => ({
      targetId: target.id,
      targetType: 'virtual_machine',
      workspaceId: target.workspaceId,
      agentKeyHash: 'redacted-hash',
      keyVersion: 1,
      capabilities: ['read'],
      lastSeenAt: null,
      lastHeartbeatAt: null,
      connectorVersion: null,
      metadata: {},
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    });
    repo.agentv.createAgentVEnrollment = async () => true;
    repo.insertWorkspaceAuditEvent = async (event) => { audits.push(event); };
    const res = response();

    await createVirtualMachineAgentEnrollment(request({ purpose: 'replace' }) as never, res as never, (error?: unknown) => {
      if (error) throw error;
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    const command = assertStructuredInstructions(res.body);
    assert.match(command, /--replace-credential$/);
    const auditJson = JSON.stringify(audits);
    assert.ok(!auditJson.includes(command));
    assert.ok(!auditJson.includes('install-agentv.sh'));
  });

  it('removes a newly registered VM when its initial enrollment cannot be created', async () => {
    let deletedId: string | undefined;
    repo.getWorkspaceRole = async () => 'owner';
    repo.addVirtualMachine = async () => virtualMachine;
    repo.agentv.createAgentVEnrollment = async () => false;
    repo.deleteVirtualMachine = async (id) => { deletedId = id; return true; };
    const res = response();
    let forwarded: unknown;

    await registerVirtualMachine(request({ name: virtualMachine.name }) as never, res as never, (error?: unknown) => {
      forwarded = error;
    });

    assert.ok(forwarded instanceof Error);
    assert.equal(deletedId, virtualMachine.id);
  });

  it('returns repair instructions only when AgentV has an active credential', async () => {
    repo.getWorkspaceRole = async () => 'owner';
    repo.getTarget = async () => target;
    repo.getTargetAgentRegistration = async () => null;
    const missingRes = response();
    await getVirtualMachineInstallInstructions(request() as never, missingRes as never, (error?: unknown) => {
      if (error) throw error;
    });
    assert.equal(missingRes.statusCode, 409);

    repo.getTargetAgentRegistration = async () => ({
      targetId: target.id,
      targetType: 'virtual_machine',
      workspaceId: target.workspaceId,
      agentKeyHash: 'redacted-hash',
      keyVersion: 1,
      capabilities: ['read'],
      lastSeenAt: null,
      lastHeartbeatAt: null,
      connectorVersion: null,
      metadata: {},
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    });
    const activeRes = response();
    await getVirtualMachineInstallInstructions(request() as never, activeRes as never, (error?: unknown) => {
      if (error) throw error;
    });
    assert.equal(activeRes.statusCode, 200);
    const body = activeRes.body as { installInstructions: { command: string; enrollmentExpiresAt?: string } };
    assert.doesNotMatch(body.installInstructions.command, /--enrollment-token/);
    assert.equal(body.installInstructions.enrollmentExpiresAt, undefined);
  });
});
