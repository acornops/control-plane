import assert from 'node:assert/strict';

/** Exercise legacy suspension and intermediate receipt data through additive upgrades. */
export async function applyAndCheckHostedMigrations(client, migrationFiles, migrations) {
  const startedAt = '2026-08-01T02:03:04.123Z';
  await client.query(`INSERT INTO workspaces(id,name,created_by,lifecycle_status,suspended_at)
    VALUES('migration-held','Held before upgrade','migration-user-active','suspended',$1)`, [startedAt]);
  const policyIndex = migrationFiles.findIndex(name => name.startsWith('007_'));
  assert.ok(policyIndex > 0);
  for (let index = policyIndex; index < migrations.length; index++) {
    await client.query(migrations[index]);
    if (index === policyIndex) {
      await client.query(`INSERT INTO workspace_policy_receipts(workspace_id,request_id,body_hash,response)
        VALUES('migration-held','legacy-request',$1,'{"changed":true}')`, ['a'.repeat(64)]);
    }
  }
  const hold = (await client.query(`SELECT source,public_reason,created_at FROM workspace_suspension_holds
    WHERE workspace_id='migration-held'`)).rows[0];
  assert.equal(hold.source, 'admin');
  assert.equal(hold.created_at.toISOString(), startedAt);
  assert.equal(hold.public_reason, 'Workspace access is temporarily suspended by an administrator.');
  const workspace = (await client.query("SELECT lifecycle_status,suspended_at,policy_version FROM workspaces WHERE id='migration-held'")).rows[0];
  assert.equal(workspace.lifecycle_status, 'suspended');
  assert.equal(workspace.suspended_at.toISOString(), startedAt);
  assert.equal(workspace.policy_version, '0');
  const receipt = (await client.query("SELECT admin_token_id,operation,response FROM workspace_policy_receipts WHERE request_id='legacy-request'")).rows[0];
  assert.equal(receipt.admin_token_id, '__legacy_unattributed__');
  assert.equal(receipt.operation, 'plan');
  assert.deepEqual(receipt.response, { changed: true });
  assert.equal((await client.query("SELECT count(*)::int AS count FROM workspace_lifecycle_outbox WHERE workspace_id='migration-held' AND completed_at IS NULL")).rows[0].count, 1);
  const rollout = (await client.query('SELECT active,verified_at FROM workspace_capacity_rollout WHERE singleton')).rows[0];
  assert.deepEqual(rollout, { active: false, verified_at: null });
  await client.query("DELETE FROM workspaces WHERE id='migration-held'");
}
