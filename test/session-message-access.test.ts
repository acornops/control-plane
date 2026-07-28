import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkspaceAuthorization } from '../src/auth/workspace-authorization.js';
import { resolveSessionMessageAccess } from '../src/controllers/session-message-access.js';
import type { ChatSession } from '../src/types/domain.js';

function authorization(capabilities: string[]): WorkspaceAuthorization {
  return {
    userId: 'user-2',
    workspaceId: 'workspace-1',
    role: 'operator',
    permissions: {},
    can: (capability) => capabilities.includes(capability)
  } as WorkspaceAuthorization;
}

function session(origin: ChatSession['origin'], createdBy = 'user-1'): ChatSession {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    targetId: 'target-1',
    targetType: 'kubernetes',
    createdBy,
    origin,
    automaticInvestigation: origin === 'auto_triage'
      ? {
          issueId: 'issue-1',
          lifecycleVersion: 1,
          severity: 'warning',
          writeMode: 'approval_required',
          effectiveToolMode: 'read_write',
          confirmationRequiredForWrite: true
        }
      : undefined,
    title: 'Investigation',
    status: 'open',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    lastMessageAt: '2026-07-29T00:00:00.000Z',
    expiresAt: '2026-08-05T00:00:00.000Z'
  };
}

describe('session message access', () => {
  it('preserves creator-only replies for manual sessions', () => {
    const result = resolveSessionMessageAccess({
      authz: authorization(['create_sessions', 'create_read_only_runs']),
      credentialType: 'session',
      requestedToolAccessMode: 'read_only',
      session: session('manual'),
      userId: 'user-2'
    });
    assert.deepEqual(result, {
      allowed: false,
      code: 'CONVERSATION_OWNER_REQUIRED',
      message: 'Only the user who started this conversation can send follow-up messages.'
    });
  });

  it('allows browser members to collaborate in automatic sessions', () => {
    const result = resolveSessionMessageAccess({
      authz: authorization(['create_sessions', 'create_read_only_runs']),
      credentialType: 'session',
      requestedToolAccessMode: 'read_only',
      session: session('auto_triage'),
      userId: 'user-2'
    });
    assert.deepEqual(result, {
      allowed: true,
      sharedAutomaticSession: true,
      toolAccessMode: 'read_only'
    });
  });

  it('does not extend shared participation to external integrations', () => {
    const result = resolveSessionMessageAccess({
      authz: authorization(['create_sessions', 'create_read_only_runs']),
      credentialType: 'external_integration',
      requestedToolAccessMode: 'read_only',
      session: session('auto_triage'),
      userId: 'user-2'
    });
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, 'CONVERSATION_OWNER_REQUIRED');
  });

  it('keeps the pinned automatic read-only ceiling for human replies', () => {
    const automaticSession = session('auto_triage');
    automaticSession.automaticInvestigation!.effectiveToolMode = 'read_only';
    const result = resolveSessionMessageAccess({
      authz: authorization(['create_sessions', 'create_read_only_runs', 'create_read_write_runs']),
      credentialType: 'session',
      requestedToolAccessMode: 'read_write',
      session: automaticSession,
      userId: 'user-2'
    });
    assert.equal(result.allowed, true);
    if (result.allowed) assert.equal(result.toolAccessMode, 'read_only');
  });
});
