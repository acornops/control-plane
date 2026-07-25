import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  addWorkspaceMember,
  listWorkspaceMemberCandidates as listWorkspaceMemberCandidatesController
} from '../src/controllers/workspaces/members-controller.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { applyPlatformSettingOverrides } from '../src/services/platform-settings.js';
import { repo } from '../src/store/repository.js';
import { listWorkspaceMemberCandidates } from '../src/store/repository-workspaces.js';

const mutableConfig = config as typeof config & {
  PLATFORM_SETTINGS_POLICY: typeof config.PLATFORM_SETTINGS_POLICY;
};
const originalPlatformSettingsPolicy = config.PLATFORM_SETTINGS_POLICY;

function createResponse() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

function authenticatedRequest(input: { query?: Record<string, unknown>; body?: Record<string, unknown> } = {}) {
  return {
    auth: {
      userId: '11111111-1111-4111-8111-111111111111',
      credential: { type: 'session', sessionId: 'session-1' }
    },
    params: { workspaceId: '22222222-2222-4222-8222-222222222222' },
    query: input.query || {},
    body: input.body || {}
  };
}

afterEach(() => {
  mock.restoreAll();
  mutableConfig.PLATFORM_SETTINGS_POLICY = originalPlatformSettingsPolicy;
  applyPlatformSettingOverrides([]);
});

describe('workspace member discovery repository', () => {
  it('uses exact email matching and returns bounded authentication provenance', async () => {
    let observedSql = '';
    let observedParams: unknown[] = [];
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      observedSql = sql;
      observedParams = params || [];
      return {
        rowCount: 1,
        rows: [{
          user_id: 'user-1',
          email: 'person@example.com',
          display_name: 'Person',
          has_oidc: true,
          has_password: false,
          status: 'available'
        }]
      };
    });

    const candidates = await listWorkspaceMemberCandidates(
      'workspace-1',
      'Person@Example.com',
      'exact_email',
      8
    );

    assert.match(observedSql, /LOWER\(u\.email\) = \$2/);
    assert.match(observedSql, /fi\.last_login_at IS NOT NULL/);
    assert.match(observedSql, /u\.email_verification_required = false OR u\.email_verified_at IS NOT NULL/);
    assert.deepEqual(observedParams, ['workspace-1', 'person@example.com', 'person@example.com', 8]);
    assert.deepEqual(candidates, [{
      userId: 'user-1',
      email: 'person@example.com',
      displayName: 'Person',
      authMethods: ['oidc'],
      status: 'available'
    }]);
  });

  it('uses substring matching only for explicitly enabled directory mode', async () => {
    let observedSql = '';
    let observedParams: unknown[] = [];
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      observedSql = sql;
      observedParams = params || [];
      return { rowCount: 0, rows: [] };
    });

    await listWorkspaceMemberCandidates('workspace-1', 'per', 'directory', 100);

    assert.match(observedSql, /STRPOS\(LOWER\(u\.email\), \$2\) > 0/);
    assert.match(observedSql, /STRPOS\(LOWER\(u\.display_name\), \$2\) > 0/);
    assert.deepEqual(observedParams, ['workspace-1', 'per', 'per', 20]);
  });

  it('treats SQL wildcard characters as literal directory search text', async () => {
    let observedSql = '';
    let observedParams: unknown[] = [];
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      observedSql = sql;
      observedParams = params || [];
      return { rowCount: 0, rows: [] };
    });

    await listWorkspaceMemberCandidates('workspace-1', '%%', 'directory');

    assert.doesNotMatch(observedSql, /LIKE \$2/);
    assert.deepEqual(observedParams, ['workspace-1', '%%', '%%', 8]);
  });
});

describe('workspace member discovery controller', () => {
  it('rejects overlong search input before directory lookup', async () => {
    mutableConfig.PLATFORM_SETTINGS_POLICY = {
      ...originalPlatformSettingsPolicy,
      memberDiscovery: {
        ...originalPlatformSettingsPolicy.memberDiscovery,
        allowedModes: ['disabled', 'exact_email', 'directory']
      }
    };
    applyPlatformSettingOverrides([{
      key: 'member_discovery',
      overrideValue: { mode: 'directory' },
      version: 1,
      updatedAt: '2026-07-25T00:00:00.000Z'
    }]);
    mock.method(repo, 'getWorkspaceRole', async () => 'owner');
    const lookup = mock.method(repo, 'listWorkspaceMemberCandidates', async () => []);
    const res = createResponse();

    await listWorkspaceMemberCandidatesController(
      authenticatedRequest({ query: { q: 'a'.repeat(201) } }) as never,
      res as never,
      (error?: unknown) => { if (error) throw error; }
    );

    assert.equal(res.statusCode, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
    assert.equal(lookup.mock.callCount(), 0);
  });

  it('blocks direct member addition when discovery is disabled', async () => {
    applyPlatformSettingOverrides([{
      key: 'member_discovery',
      overrideValue: { mode: 'disabled' },
      version: 1,
      updatedAt: '2026-07-25T00:00:00.000Z'
    }]);
    mock.method(repo, 'getWorkspaceRole', async () => 'owner');
    const add = mock.method(repo, 'addWorkspaceMember', async () => {
      throw new Error('direct add must not be reached');
    });
    const res = createResponse();

    await addWorkspaceMember(
      authenticatedRequest({
        body: {
          userId: '33333333-3333-4333-8333-333333333333',
          email: 'member@example.com',
          role: 'viewer'
        }
      }) as never,
      res as never,
      (error?: unknown) => { if (error) throw error; }
    );

    assert.equal(res.statusCode, 403);
    assert.equal(
      (res.body as { error: { code: string } }).error.code,
      'MEMBER_DISCOVERY_DISABLED'
    );
    assert.equal(add.mock.callCount(), 0);
  });

  it('binds the selected user id and email when adding an existing user', async () => {
    mock.method(repo, 'getWorkspaceRole', async () => 'owner');
    const add = mock.method(repo, 'addWorkspaceMember', async () => ({
      status: 'created' as const,
      member: {
        workspaceId: '22222222-2222-4222-8222-222222222222',
        userId: '33333333-3333-4333-8333-333333333333',
        email: 'member@example.com',
        displayName: 'Member',
        role: 'viewer',
        source: 'oidc' as const,
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z'
      }
    }));
    const res = createResponse();

    await addWorkspaceMember(
      authenticatedRequest({
        body: {
          userId: '33333333-3333-4333-8333-333333333333',
          email: 'Member@Example.com',
          role: 'viewer'
        }
      }) as never,
      res as never,
      (error?: unknown) => { if (error) throw error; }
    );

    assert.equal(res.statusCode, 201);
    assert.deepEqual(add.mock.calls[0].arguments, [
      '22222222-2222-4222-8222-222222222222',
      {
        userId: '33333333-3333-4333-8333-333333333333',
        email: 'Member@Example.com',
        role: 'viewer'
      },
      '11111111-1111-4111-8111-111111111111'
    ]);
  });
});
