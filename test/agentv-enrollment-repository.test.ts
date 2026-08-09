import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { db } from '../src/infra/db.js';
import { agentVEnrollmentRepository as enrollmentRepo } from '../src/store/repository-agentv-enrollments.js';
import { hashSecret } from '../src/utils/crypto.js';
import { closeAutomationDatabaseFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

const hasIsolatedDatabase = Boolean(process.env.CONTROL_PLANE_TEST_DATABASE_URL);
const token = (id: string, character: string) => `aev_${id}_${character.repeat(43)}`;

describe('AgentV enrollment credential transactions', { skip: !hasIsolatedDatabase }, () => {
  beforeEach(async () => {
    await resetAutomationDatabaseFixtures();
    await db.query(
      `INSERT INTO targets (id, workspace_id, target_type, name, status, metadata, created_at, updated_at)
       VALUES ('vm-1', 'workspace-1', 'virtual_machine', 'Test VM', 'unknown', '{}', NOW(), NOW())`
    );
  });
  after(closeAutomationDatabaseFixtures);

  it('stores only hashes, consumes once, and restores the prior credential after a committed replacement', async () => {
    const initialId = '11111111-1111-4111-8111-111111111111';
    const initialToken = token(initialId, 'a');
    await enrollmentRepo.createAgentVEnrollment({
      id: initialId, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'initial',
      tokenHash: hashSecret(initialToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const initial = await enrollmentRepo.exchangeAgentVEnrollment({ enrollmentId: initialId, token: initialToken, targetId: 'vm-1', purpose: 'initial' });
    assert.ok(initial);
    assert.equal(await enrollmentRepo.exchangeAgentVEnrollment({ enrollmentId: initialId, token: initialToken, targetId: 'vm-1', purpose: 'initial' }), null);
    const stored = await db.query('SELECT token_hash, transaction_secret_hash FROM agentv_enrollments WHERE id=$1', [initialId]);
    assert.notEqual(stored.rows[0].token_hash, initialToken);
    assert.notEqual(stored.rows[0].transaction_secret_hash, initial.transactionSecret);
    const storedKey = await db.query('SELECT key_hash FROM agentv_credentials WHERE enrollment_id=$1', [initialId]);
    assert.notEqual(storedKey.rows[0].key_hash, initial.agentKey);

    assert.equal((await enrollmentRepo.authenticateAgentVCredential('vm-1', initial.agentKey))?.provisional, true);
    assert.equal((await enrollmentRepo.commitAgentVInstallation(initialId, initial.transactionSecret))?.state, 'active');

    const staleInitialId = '77777777-7777-4777-8777-777777777777';
    const staleInitialToken = token(staleInitialId, 'g');
    await enrollmentRepo.createAgentVEnrollment({
      id: staleInitialId, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'initial',
      tokenHash: hashSecret(staleInitialToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(await enrollmentRepo.exchangeAgentVEnrollment({
      enrollmentId: staleInitialId, token: staleInitialToken, targetId: 'vm-1', purpose: 'initial'
    }), null);

    const replacementId = '22222222-2222-4222-8222-222222222222';
    const replacementToken = token(replacementId, 'b');
    await enrollmentRepo.createAgentVEnrollment({
      id: replacementId, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'replace',
      tokenHash: hashSecret(replacementToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const replacement = await enrollmentRepo.exchangeAgentVEnrollment({ enrollmentId: replacementId, token: replacementToken, targetId: 'vm-1', purpose: 'replace' });
    assert.ok(replacement);
    assert.equal((await enrollmentRepo.authenticateAgentVCredential('vm-1', replacement.agentKey))?.provisional, true);
    assert.equal((await enrollmentRepo.commitAgentVInstallation(replacementId, replacement.transactionSecret))?.generation, 2);
    assert.equal((await enrollmentRepo.authenticateAgentVCredential('vm-1', initial.agentKey))?.credential.state, 'grace');

    assert.equal(await enrollmentRepo.rollbackAgentVInstallation(replacementId, replacement.transactionSecret), true);
    assert.equal((await enrollmentRepo.authenticateAgentVCredential('vm-1', initial.agentKey))?.credential.state, 'active');
    assert.equal(await enrollmentRepo.authenticateAgentVCredential('vm-1', replacement.agentKey), null);
    const registration = await db.query('SELECT key_version FROM target_agent_registrations WHERE target_id=$1', ['vm-1']);
    assert.equal(registration.rows[0].key_version, 1);
  });

  it('allows only one concurrent pending credential for a target', async () => {
    const firstId = '33333333-3333-4333-8333-333333333333';
    const secondId = '44444444-4444-4444-8444-444444444444';
    const firstToken = token(firstId, 'c');
    const secondToken = token(secondId, 'd');
    await Promise.all([
      enrollmentRepo.createAgentVEnrollment({ id: firstId, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'initial', tokenHash: hashSecret(firstToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      enrollmentRepo.createAgentVEnrollment({ id: secondId, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'initial', tokenHash: hashSecret(secondToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    ]);
    const results = await Promise.all([
      enrollmentRepo.exchangeAgentVEnrollment({ enrollmentId: firstId, token: firstToken, targetId: 'vm-1', purpose: 'initial' }),
      enrollmentRepo.exchangeAgentVEnrollment({ enrollmentId: secondId, token: secondToken, targetId: 'vm-1', purpose: 'initial' })
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const pending = await db.query("SELECT COUNT(*)::int AS count FROM agentv_credentials WHERE target_id='vm-1' AND state='pending'");
    assert.equal(pending.rows[0].count, 1);
  });

  it('lets a freshly generated command retire an abandoned pending enrollment', async () => {
    const abandonedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const freshId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const abandonedToken = token(abandonedId, 'l');
    const freshToken = token(freshId, 'm');
    assert.equal(await enrollmentRepo.createAgentVEnrollment({
      id: abandonedId, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'initial',
      tokenHash: hashSecret(abandonedToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
    }), true);
    assert.ok(await enrollmentRepo.exchangeAgentVEnrollment({
      enrollmentId: abandonedId, token: abandonedToken, targetId: 'vm-1', purpose: 'initial'
    }));

    assert.equal(await enrollmentRepo.createAgentVEnrollment({
      id: freshId, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'initial',
      tokenHash: hashSecret(freshToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
    }), true);
    const abandoned = await db.query(
      `SELECT e.status, c.state FROM agentv_enrollments e
       JOIN agentv_credentials c ON c.enrollment_id=e.id WHERE e.id=$1`,
      [abandonedId]
    );
    assert.deepEqual(abandoned.rows[0], { status: 'cancelled', state: 'revoked' });
    assert.ok(await enrollmentRepo.exchangeAgentVEnrollment({
      enrollmentId: freshId, token: freshToken, targetId: 'vm-1', purpose: 'initial'
    }));
  });

  it('rejects replacement enrollment when the target has no active credential', async () => {
    const id = '88888888-8888-4888-8888-888888888888';
    const rawToken = token(id, 'h');
    assert.equal(await enrollmentRepo.createAgentVEnrollment({
      id, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'replace',
      tokenHash: hashSecret(rawToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
    }), false);
    assert.equal(await enrollmentRepo.exchangeAgentVEnrollment({
      enrollmentId: id, token: rawToken, targetId: 'vm-1', purpose: 'replace'
    }), null);
  });

  it('expires an abandoned exchanged credential and rejects target mismatches', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    const rawToken = token(id, 'e');
    await enrollmentRepo.createAgentVEnrollment({
      id, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'initial',
      tokenHash: hashSecret(rawToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(await enrollmentRepo.exchangeAgentVEnrollment({ enrollmentId: id, token: rawToken, targetId: 'other-vm', purpose: 'initial' }), null);
    assert.equal(await enrollmentRepo.exchangeAgentVEnrollment({ enrollmentId: id, token: rawToken, targetId: 'vm-1', purpose: 'replace' }), null);
    const exchanged = await enrollmentRepo.exchangeAgentVEnrollment({ enrollmentId: id, token: rawToken, targetId: 'vm-1', purpose: 'initial' });
    assert.ok(exchanged);
    await db.query("UPDATE agentv_enrollments SET transaction_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [id]);
    await enrollmentRepo.expireAgentVEnrollmentState();
    const state = await db.query(
      `SELECT e.status, c.state FROM agentv_enrollments e JOIN agentv_credentials c ON c.enrollment_id=e.id WHERE e.id=$1`, [id]
    );
    assert.deepEqual(state.rows[0], { status: 'expired', state: 'revoked' });
    const recoveryStatus = await enrollmentRepo.getAgentVInstallationStatus(id, exchanged.transactionSecret);
    assert.equal(recoveryStatus?.enrollment.status, 'expired');
    assert.equal(await enrollmentRepo.commitAgentVInstallation(id, exchanged.transactionSecret), null);
    assert.equal(await enrollmentRepo.rollbackAgentVInstallation(id, exchanged.transactionSecret), false);
  });

  it('can cancel an initial credential after commit when post-commit readiness fails', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    const rawToken = token(id, 'f');
    await enrollmentRepo.createAgentVEnrollment({
      id, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'initial',
      tokenHash: hashSecret(rawToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const exchanged = await enrollmentRepo.exchangeAgentVEnrollment({
      enrollmentId: id, token: rawToken, targetId: 'vm-1', purpose: 'initial'
    });
    assert.ok(exchanged);
    await enrollmentRepo.authenticateAgentVCredential('vm-1', exchanged.agentKey);
    assert.ok(await enrollmentRepo.commitAgentVInstallation(id, exchanged.transactionSecret));
    assert.equal(await enrollmentRepo.rollbackAgentVInstallation(id, exchanged.transactionSecret), true);
    const state = await db.query('SELECT state FROM agentv_credentials WHERE enrollment_id=$1', [id]);
    assert.equal(state.rows[0].state, 'revoked');
    const registration = await db.query('SELECT target_id FROM target_agent_registrations WHERE target_id=$1', ['vm-1']);
    assert.equal(registration.rowCount, 0);
  });

  it('does not revoke the active replacement after the prior credential grace window expires', async () => {
    const initialId = '99999999-9999-4999-8999-999999999999';
    const replacementId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const initialToken = token(initialId, 'i');
    const replacementToken = token(replacementId, 'j');
    await enrollmentRepo.createAgentVEnrollment({
      id: initialId, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'initial',
      tokenHash: hashSecret(initialToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const initial = await enrollmentRepo.exchangeAgentVEnrollment({
      enrollmentId: initialId, token: initialToken, targetId: 'vm-1', purpose: 'initial'
    });
    assert.ok(initial);
    await enrollmentRepo.authenticateAgentVCredential('vm-1', initial.agentKey);
    await enrollmentRepo.commitAgentVInstallation(initialId, initial.transactionSecret);

    await enrollmentRepo.createAgentVEnrollment({
      id: replacementId, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'replace',
      tokenHash: hashSecret(replacementToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const replacement = await enrollmentRepo.exchangeAgentVEnrollment({
      enrollmentId: replacementId, token: replacementToken, targetId: 'vm-1', purpose: 'replace'
    });
    assert.ok(replacement);
    await enrollmentRepo.authenticateAgentVCredential('vm-1', replacement.agentKey);
    await enrollmentRepo.commitAgentVInstallation(replacementId, replacement.transactionSecret);
    await db.query("UPDATE agentv_credentials SET grace_expires_at=NOW()-INTERVAL '1 second' WHERE state='grace'");

    assert.equal(await enrollmentRepo.rollbackAgentVInstallation(replacementId, replacement.transactionSecret), false);
    assert.equal((await enrollmentRepo.authenticateAgentVCredential('vm-1', replacement.agentKey))?.credential.state, 'active');
    const registration = await db.query('SELECT key_version FROM target_agent_registrations WHERE target_id=$1', ['vm-1']);
    assert.equal(registration.rows[0].key_version, 2);
  });

  it('keeps only the immediately previous credential during successive replacement grace windows', async () => {
    const activate = async (id: string, character: string, purpose: 'initial' | 'replace') => {
      const rawToken = token(id, character);
      assert.equal(await enrollmentRepo.createAgentVEnrollment({
        id, targetId: 'vm-1', workspaceId: 'workspace-1', purpose,
        tokenHash: hashSecret(rawToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
      }), true);
      const exchanged = await enrollmentRepo.exchangeAgentVEnrollment({
        enrollmentId: id, token: rawToken, targetId: 'vm-1', purpose
      });
      assert.ok(exchanged);
      await enrollmentRepo.authenticateAgentVCredential('vm-1', exchanged.agentKey);
      assert.ok(await enrollmentRepo.commitAgentVInstallation(id, exchanged.transactionSecret));
      return exchanged.agentKey;
    };

    const initialKey = await activate('12121212-1212-4212-8212-121212121212', 'n', 'initial');
    const firstReplacementKey = await activate('13131313-1313-4313-8313-131313131313', 'o', 'replace');
    const secondReplacementKey = await activate('14141414-1414-4414-8414-141414141414', 'p', 'replace');

    assert.equal(await enrollmentRepo.authenticateAgentVCredential('vm-1', initialKey), null);
    assert.equal((await enrollmentRepo.authenticateAgentVCredential('vm-1', firstReplacementKey))?.credential.state, 'grace');
    assert.equal((await enrollmentRepo.authenticateAgentVCredential('vm-1', secondReplacementKey))?.credential.state, 'active');
    const states = await db.query(
      `SELECT state, COUNT(*)::int AS count FROM agentv_credentials
       WHERE target_id='vm-1' GROUP BY state ORDER BY state`
    );
    assert.deepEqual(states.rows, [
      { state: 'active', count: 1 },
      { state: 'grace', count: 1 },
      { state: 'revoked', count: 1 }
    ]);
  });

  it('reports an active connection only for the committed credential generation', async () => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const rawToken = token(id, 'k');
    await enrollmentRepo.createAgentVEnrollment({
      id, targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'initial',
      tokenHash: hashSecret(rawToken), createdBy: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const exchanged = await enrollmentRepo.exchangeAgentVEnrollment({
      enrollmentId: id, token: rawToken, targetId: 'vm-1', purpose: 'initial'
    });
    assert.ok(exchanged);
    await enrollmentRepo.authenticateAgentVCredential('vm-1', exchanged.agentKey);
    await enrollmentRepo.commitAgentVInstallation(id, exchanged.transactionSecret);
    await db.query(
      `UPDATE target_agent_registrations
       SET last_heartbeat_at=NOW(), last_authenticated_key_version=2 WHERE target_id='vm-1'`
    );
    assert.equal((await enrollmentRepo.getAgentVInstallationStatus(id, exchanged.transactionSecret))?.activeConnected, false);
    await db.query(
      `UPDATE target_agent_registrations
       SET last_heartbeat_at=NOW(), last_authenticated_key_version=1 WHERE target_id='vm-1'`
    );
    assert.equal((await enrollmentRepo.getAgentVInstallationStatus(id, exchanged.transactionSecret))?.activeConnected, true);
  });
});
