import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { assertDatabaseMigrationsCurrent } from '../infra/migrations.js';
import { workspaceCatalogFingerprint } from '../services/workspace-capacity-rollout.js';
import { preflightWorkspacePlanCatalog } from '../store/repository-workspace-policy-read.js';
import { withTransaction } from '../store/repository-transaction.js';
import { resolveExecutionLimits } from '../types/workspace-policy.js';
import type { PoolClient } from 'pg';

type Peer = { service: 'control-plane' | 'execution-engine' | 'llm-gateway'; url: string };
async function verifyPeers(path: string, enabled: boolean): Promise<void> {
  const peers: Peer[] = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(peers) || !peers.length || peers.length > 100) throw new Error('Provide all replicas in a peer array (1–100)');
  for (const service of ['control-plane', 'execution-engine', 'llm-gateway']) {
    if (!peers.some(peer => peer.service === service)) throw new Error(`Missing ${service} peer`);
  }
  for (const peer of peers) {
    if (!['control-plane', 'execution-engine', 'llm-gateway'].includes(peer.service)) throw new Error('Unknown peer service');
    const url = new URL('/health', peer.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Peer URLs must use HTTP(S) without credentials');
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error(`Peer health failed: ${peer.service}`);
    const health = await response.json() as Record<string, unknown>;
    if (health.capacity_contract_version !== 1 || health.capacity_enabled !== enabled) throw new Error(`Incompatible peer: ${peer.service}`);
    if (peer.service === 'control-plane' && (health.admission_enabled !== false || health.dispatch_enabled !== false
      || health.workspace_catalog_hash !== workspaceCatalogFingerprint())) throw new Error('Control-plane peer is not quiesced with the same catalogue');
  }
}
async function assertQuiesced(queryable: Pick<PoolClient, 'query'> = db): Promise<void> {
  const active = await queryable.query(`SELECT 1 FROM runs WHERE status IN ('running','dispatching','cancelling')
    UNION ALL SELECT 1 FROM workflow_runs WHERE status IN ('running','dispatching','cancelling')
    UNION ALL SELECT 1 FROM workspace_run_reservations WHERE settled_at IS NULL AND executing_until IS NOT NULL
    UNION ALL SELECT 1 FROM workspace_run_operations WHERE finished_at IS NULL AND deadline>clock_timestamp()
    UNION ALL SELECT 1 FROM target_insights_checkpoint_jobs WHERE status='processing'
    UNION ALL SELECT 1 FROM target_auto_triage_jobs WHERE status='processing' LIMIT 1`);
  if (active.rowCount) throw new Error('Execution or bounded in-flight operations remain; drain and reconcile before changing mode');
}
async function prepare(): Promise<void> {
  await withTransaction(async client => {
    await client.query('SELECT singleton FROM workspace_capacity_rollout WHERE singleton FOR UPDATE');
    await assertQuiesced(client);
    // Legacy admission time is unknown; backfill must not turn historical work
    // into a post-restore admission. Keep eligibility/queue deadlines current.
    await client.query(`INSERT INTO workspace_run_reservations(run_id,workspace_id,pool,state,queue_expires_at,created_at)
      SELECT r.id,r.workspace_id,CASE WHEN s.origin='auto_triage' THEN 'autoTriage'
        WHEN r.conversation_kind='agent_chat' THEN 'agent' ELSE 'chat' END,'queued',clock_timestamp()+INTERVAL '600 seconds','-infinity'::timestamptz
      FROM runs r JOIN sessions s ON s.id=r.session_id JOIN workspaces w ON w.id=r.workspace_id
      WHERE r.status IN ('queued','waiting_for_approval') AND w.lifecycle_status='active' ON CONFLICT(run_id) DO NOTHING`);
    await client.query(`INSERT INTO automation_dispatch_outbox(id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
      SELECT gen_random_uuid()::text,r.workspace_id,'conversation',r.id,r.id,'conversation:'||r.id,jsonb_build_object('runId',r.id)
      FROM runs r JOIN sessions s ON s.id=r.session_id JOIN workspaces w ON w.id=r.workspace_id
      WHERE r.status='queued' AND s.origin<>'auto_triage' AND w.lifecycle_status='active'
      ON CONFLICT(idempotency_key) DO NOTHING`);
    await client.query(`INSERT INTO workspace_run_reservations(run_id,workspace_id,pool,state,queue_expires_at,created_at)
      SELECT r.id,r.workspace_id,'workflow','queued',clock_timestamp()+INTERVAL '600 seconds','-infinity'::timestamptz
      FROM workflow_runs r JOIN workspaces w ON w.id=r.workspace_id
      WHERE r.status IN ('queued','waiting_for_approval') AND w.lifecycle_status='active' ON CONFLICT(run_id) DO NOTHING`);
    const jobs = await client.query<{ id: string; workspace_id: string }>(`SELECT j.id,j.workspace_id FROM target_auto_triage_jobs j
      JOIN workspaces w ON w.id=j.workspace_id WHERE j.run_id IS NULL AND j.reserved_run_id IS NULL
      AND j.status IN ('queued','processing','blocked') AND w.lifecycle_status='active' FOR UPDATE OF j`);
    for (const job of jobs.rows) {
      const runId = randomUUID();
      await client.query(`INSERT INTO workspace_run_reservations(run_id,workspace_id,pool,queue_expires_at,created_at)
        VALUES($1,$2,'autoTriage',clock_timestamp()+INTERVAL '600 seconds','-infinity'::timestamptz)`, [runId, job.workspace_id]);
      await client.query('UPDATE target_auto_triage_jobs SET reserved_run_id=$2 WHERE id=$1', [job.id, runId]);
    }
    await client.query(`UPDATE workspace_capacity_rollout SET active=true,catalog_hash=$1,activated_at=clock_timestamp(),verified_at=NULL WHERE singleton`, [workspaceCatalogFingerprint()]);
  });
}
async function main(): Promise<void> {
  const [command, peerFile, ...flags] = process.argv.slice(2);
  if (!['prepare', 'verify', 'deactivate'].includes(command) || !peerFile || flags.some(flag => flag !== '--require-finite')) {
    throw new Error('Usage: npm run capacity:rollout -- prepare|verify|deactivate peers.json [--require-finite]');
  }
  if (config.WORKSPACE_ADMISSION_ENABLED || config.WORKSPACE_DISPATCH_ENABLED) throw new Error('Close admission and dispatch on all replicas first');
  await assertDatabaseMigrationsCurrent(db);
  await preflightWorkspacePlanCatalog();
  if (flags.includes('--require-finite')) for (const plan of config.WORKSPACE_PLANS.plans) {
    if (Object.values(resolveExecutionLimits(plan.executionLimits)).some(pool => pool.maxConcurrentRuns === null || pool.maxOutstandingRuns === null)) {
      throw new Error(`Hosted activation requires five finite pools: ${plan.key}`);
    }
  }
  await verifyPeers(peerFile, command === 'verify');
  await assertQuiesced();
  if (command === 'prepare') await prepare();
  if (command === 'deactivate') await db.query('UPDATE workspace_capacity_rollout SET active=false,verified_at=NULL WHERE singleton');
  if (command === 'verify') {
    const verified = await db.query(`UPDATE workspace_capacity_rollout SET verified_at=clock_timestamp()
      WHERE singleton AND active AND catalog_hash=$1 RETURNING singleton`, [workspaceCatalogFingerprint()]);
    if (!verified.rowCount) throw new Error('Prepare this catalogue before verifying peers');
  }
  console.log(`Workspace capacity ${command} completed for catalogue ${workspaceCatalogFingerprint()}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Rollout failed'); process.exitCode = 1; }).finally(() => db.end());
