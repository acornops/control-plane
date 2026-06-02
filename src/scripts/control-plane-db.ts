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

async function main(): Promise<void> {
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

  throw new Error(`Unknown command: ${command}. Expected migrate, status, or check.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
