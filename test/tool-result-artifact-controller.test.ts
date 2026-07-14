import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, it } from 'node:test';
import {
  createToolResultArtifact,
  getToolResultArtifact
} from '../src/controllers/tool-result-artifact-controller.js';
import { repo } from '../src/store/repository.js';

const originals = {
  getRun: repo.getRun,
  getWorkspaceRole: repo.getWorkspaceRole,
  getToolResultArtifact: repo.getToolResultArtifact,
  insertWorkspaceAuditEvent: repo.insertWorkspaceAuditEvent,
  upsertToolResultArtifact: repo.upsertToolResultArtifact,
};

afterEach(() => Object.assign(repo, originals));

function response() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res = {
    setHeader: (name: string, value: string) => { state.headers[name] = value; },
    status: (status: number) => { state.status = status; return res; },
    json: (body: unknown) => { state.body = body; return res; },
    send: (body: unknown) => { state.body = body; return res; },
  };
  return { res, state };
}

describe('tool result artifact download', () => {
  it('returns an indistinguishable no-store 404 without workspace data access', async () => {
    repo.getRun = async () => ({ id: 'run-1', workspaceId: 'workspace-a' } as never);
    repo.getWorkspaceRole = async () => null;
    let artifactRead = false;
    repo.getToolResultArtifact = async () => { artifactRead = true; return null; };
    const { res, state } = response();

    await getToolResultArtifact({
      params: { runId: 'run-1', artifactId: 'artifact-1' }, auth: { userId: 'user-b' },
    } as never, res as never, (error?: unknown) => { if (error) throw error; });

    assert.equal(state.status, 404);
    assert.equal(state.headers['Cache-Control'], 'no-store');
    assert.equal(artifactRead, false);
  });

  it('denies a cross-workspace artifact and streams an authorized redacted artifact', async () => {
    repo.getRun = async () => ({ id: 'run-1', workspaceId: 'workspace-a' } as never);
    repo.getWorkspaceRole = async () => 'owner';
    const base = {
      id: 'artifact-1', runId: 'run-1', callId: 'call-1', toolName: 'get_resource',
      sha256: createHash('sha256').update('{"ok":true}').digest('hex'), contentType: 'application/json', encoding: 'gzip',
      uncompressedBytes: 11, compressedBytes: 10, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), payload: gzipSync('{"ok":true}'),
    };
    repo.getToolResultArtifact = async () => ({ ...base, workspaceId: 'workspace-b' });
    const denied = response();
    await getToolResultArtifact({
      params: { runId: 'run-1', artifactId: 'artifact-1' }, auth: { userId: 'owner-a' },
    } as never, denied.res as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(denied.state.status, 404);

    repo.getToolResultArtifact = async () => ({ ...base, workspaceId: 'workspace-a' });
    let auditEvent: Record<string, unknown> | undefined;
    repo.insertWorkspaceAuditEvent = async (event) => { auditEvent = event as never; };
    const allowed = response();
    await getToolResultArtifact({
      params: { runId: 'run-1', artifactId: 'artifact-1' }, auth: { userId: 'owner-a' },
    } as never, allowed.res as never, (error?: unknown) => { if (error) throw error; });

    assert.equal(allowed.state.status, 200);
    assert.equal(allowed.state.headers['Cache-Control'], 'no-store');
    assert.equal(String(allowed.state.body), '{"ok":true}');
    assert.equal(auditEvent?.eventType, 'tool.result.read.v1');
  });
});

describe('tool result artifact creation', () => {
  it('returns bounded 413 and 409 responses for size and idempotency violations', async () => {
    repo.getRun = async () => ({ id: 'run-1', workspaceId: 'workspace-a' } as never);
    const oversized = response();
    await createToolResultArtifact({
      params: { runId: 'run-1' },
      body: { callId: 'call-large', toolName: 'get_resource', result: { token: 'x'.repeat(2 * 1024 * 1024) } },
    } as never, oversized.res as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(oversized.state.status, 413);

    repo.upsertToolResultArtifact = async (input) => ({
      ...input, sha256: '0'.repeat(64), createdAt: new Date().toISOString()
    });
    const conflict = response();
    await createToolResultArtifact({
      params: { runId: 'run-1' },
      body: { callId: 'call-1', toolName: 'get_resource', result: { ok: true } },
    } as never, conflict.res as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(conflict.state.status, 409);
  });
});
