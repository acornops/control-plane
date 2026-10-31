import assert from 'node:assert/strict';

/** Populate real FK links before the forward migrations, including unrelated history. */
export async function seedTargetDeleteIndexCheck(client) {
  await client.query(`
    INSERT INTO workspaces(id,name,created_by) VALUES ('delete-check','Deletion check','migration-user-active');
    INSERT INTO targets(id,workspace_id,target_type,name,status,created_at,updated_at)
      SELECT id,'delete-check',kind,id,'offline',now(),now()
      FROM (VALUES ('delete-vm','virtual_machine'),('delete-cluster','kubernetes')) targets(id,kind);
    INSERT INTO sessions(id,workspace_id,target_id,created_by,title,status,created_at,updated_at)
      SELECT id || '-session','delete-check',id,'migration-user-active','History','active',now(),now()
      FROM targets WHERE workspace_id='delete-check';
    INSERT INTO runs(id,workspace_id,target_id,session_id,message_id,status,requested_at)
      SELECT id || '-run','delete-check',id,id || '-session','message','succeeded',now()
      FROM targets WHERE workspace_id='delete-check';
    INSERT INTO target_issues(id,workspace_id,target_id,target_type,fingerprint,issue_type,status,severity,severity_rank,title,summary,first_seen_at,last_seen_at,last_observed_snapshot_at)
      SELECT id || '-issue','delete-check',id,target_type,id,'synthetic','resolved','warning',1,'History','History',now(),now(),now()
      FROM targets WHERE workspace_id='delete-check';
    INSERT INTO target_auto_triage_jobs(id,workspace_id,target_id,target_type,issue_id,issue_lifecycle_version,trigger_reason,status,session_id,run_id)
      SELECT id || '-job','delete-check',id,target_type,id || '-issue',1,'created','completed',id || '-session',id || '-run'
      FROM targets WHERE workspace_id='delete-check';
    INSERT INTO target_auto_triage_jobs(id,workspace_id,target_id,target_type,issue_id,issue_lifecycle_version,trigger_reason,status)
      SELECT 'delete-history-' || n,'delete-check','delete-cluster','kubernetes','delete-cluster-issue',n,'created','completed'
      FROM generate_series(2,10001) n;
  `);
}

/** Check lookup plans and FK behavior, without flaky wall-clock performance assertions. */
export async function checkTargetDeleteIndexes(client) {
  const jobs = async () => (await client.query(`
    SELECT id,session_id,run_id FROM target_auto_triage_jobs
    WHERE id IN ('delete-vm-job','delete-cluster-job') ORDER BY id
  `)).rows;
  assert.deepEqual(await jobs(), [
    { id: 'delete-cluster-job', session_id: 'delete-cluster-session', run_id: 'delete-cluster-run' },
    { id: 'delete-vm-job', session_id: 'delete-vm-session', run_id: 'delete-vm-run' }
  ], 'the upgrade must preserve existing triage links');
  await client.query('ANALYZE target_auto_triage_jobs');
  for (const column of ['run_id', 'session_id']) {
    const indexes = await client.query(`
      SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid,1,true) AS leading_column
      FROM pg_index i WHERE i.indexrelid=to_regclass($1)
        AND i.indrelid='target_auto_triage_jobs'::regclass
    `, [`idx_target_auto_triage_jobs_${column}`]);
    assert.deepEqual(indexes.rows, [{ indisvalid: true, indisready: true, leading_column: column }]);
    const value = column === 'run_id' ? 'delete-vm-run' : 'delete-vm-session';
    const plan = (await client.query(
      `EXPLAIN (FORMAT JSON) UPDATE target_auto_triage_jobs SET ${column}=NULL WHERE ${column}=$1`, [value]
    )).rows[0]['QUERY PLAN'];
    assert.match(JSON.stringify(plan), new RegExp(`idx_target_auto_triage_jobs_${column}`),
      `${column} cleanup must use an index with unrelated history present`);
  }
  await client.query("DELETE FROM runs WHERE id='delete-vm-run'");
  assert.deepEqual((await jobs())[1], { id: 'delete-vm-job', session_id: 'delete-vm-session', run_id: null });
  await client.query("DELETE FROM sessions WHERE id='delete-vm-session'");
  assert.deepEqual((await jobs())[1], { id: 'delete-vm-job', session_id: null, run_id: null });
  await client.query("DELETE FROM targets WHERE id='delete-vm'");
  assert.deepEqual(await jobs(), [
    { id: 'delete-cluster-job', session_id: 'delete-cluster-session', run_id: 'delete-cluster-run' }
  ], 'deleting one target must preserve unrelated triage links');
  assert.equal((await client.query("SELECT count(*)::int AS count FROM target_auto_triage_jobs WHERE target_id='delete-cluster'")).rows[0].count, 10001);
  await client.query("DELETE FROM sessions WHERE target_id='delete-cluster'");
  assert.deepEqual(await jobs(), [{ id: 'delete-cluster-job', session_id: null, run_id: null }]);
  await client.query("DELETE FROM targets WHERE id='delete-cluster'");
  assert.equal((await client.query("SELECT count(*)::int AS count FROM target_auto_triage_jobs WHERE workspace_id='delete-check'")).rows[0].count, 0);
  await client.query("DELETE FROM workspaces WHERE id='delete-check'");
}
