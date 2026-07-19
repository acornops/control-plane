import { Pool } from 'pg';
import { migrateDatabase, getMigrationStatus, assertDatabaseMigrationsCurrent } from '../infra/migrations.js';

const command = process.argv[2] ?? 'status';
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://acornops:acornops@localhost:5432/acornops_control_plane';
const migrationsDir = process.env.CONTROL_PLANE_MIGRATIONS_DIR;

const pool = new Pool({
  connectionString: databaseUrl,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000
});

function printStatus(
  rows: Array<{ version: number; name: string; applied: boolean; appliedAt: Date | null; checksumMatches: boolean }>
): void {
  for (const row of rows) {
    const state = row.applied ? (row.checksumMatches ? 'applied' : 'checksum-mismatch') : 'pending';
    const appliedAt = row.appliedAt ? row.appliedAt.toISOString() : '-';
    console.log(`${String(row.version).padStart(3, '0')} ${row.name} ${state} ${appliedAt}`);
  }
}

async function relationExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [name]);
  return result.rows[0]?.exists === true;
}

async function countIfPresent(table: string, where = ''): Promise<number> {
  if (!(await relationExists(table))) return 0;
  const allowed = new Set([
    'workflow_definitions', 'workflow_schedules', 'workflow_sessions',
    'automation_run_continuations', 'automation_run_approvals', 'workflow_approvals',
    'run_continuations', 'run_tool_approvals', 'runs'
  ]);
  if (!allowed.has(table)) throw new Error(`Unsupported preflight table: ${table}`);
  const result = await pool.query<{ count: string | number }>(`SELECT COUNT(*) AS count FROM ${table}${where}`);
  return Number(result.rows[0]?.count || 0);
}

async function main(): Promise<void> {
  if (command === 'capabilities:preflight') {
    const [workflowDefinitions, workflowSchedules, workflowSessions, workflowContinuations,
      workflowApprovals, workflowGateApprovals, runContinuations, runToolApprovals, activeRuns] = await Promise.all([
      countIfPresent('workflow_definitions'),
      countIfPresent('workflow_schedules'),
      countIfPresent('workflow_sessions'),
      countIfPresent('automation_run_continuations', " WHERE source_type='workflow'"),
      countIfPresent('automation_run_approvals', " WHERE source_type='workflow'"),
      countIfPresent('workflow_approvals'),
      countIfPresent('run_continuations'),
      countIfPresent('run_tool_approvals'),
      countIfPresent('runs', " WHERE status IN ('queued','dispatching','running','waiting_for_approval','cancelling')")
    ]);
    const counts = {
      workflowDefinitions,
      workflowSchedules,
      workflowSessions,
      workflowContinuations,
      workflowApprovals,
      workflowGateApprovals,
      runContinuations,
      runToolApprovals,
      activeRuns
    };
    const resetRequired = Object.values(counts).some((count) => count > 0);
    console.log(JSON.stringify({
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      migrationMode: 'greenfield_reset',
      resetRequired,
      reasonCode: resetRequired ? 'WORKFLOW_V2_DATABASE_RESET_REQUIRED' : null,
      preservesExistingData: false,
      secretFree: true,
      counts
    }, null, 2));
    if (resetRequired) process.exitCode = 2;
    return;
  }

  if (command === 'migrate') {
    const applied = await migrateDatabase(pool, migrationsDir);
    if (applied.length === 0) {
      console.log('Control-plane database migrations already current.');
    } else {
      for (const migration of applied) {
        console.log(`Applied ${migration.filename}`);
      }
    }
    return;
  }

  if (command === 'status') {
    printStatus(await getMigrationStatus(pool, migrationsDir));
    return;
  }

  if (command === 'check') {
    await assertDatabaseMigrationsCurrent(pool, migrationsDir);
    console.log('Control-plane database migrations are current.');
    return;
  }

  throw new Error(`Unknown command: ${command}. Expected migrate, status, check, or capabilities:preflight.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
