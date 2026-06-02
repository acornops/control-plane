import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, PoolClient } from 'pg';

const MIGRATION_TABLE = 'control_plane_schema_migrations';
const MIGRATION_LOCK_ID = 10_010;
const DEFAULT_MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations/control-plane');

export interface Migration {
  version: number;
  name: string;
  filename: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  version: number;
  name: string;
  checksum: string;
  applied: boolean;
  appliedAt: Date | null;
  checksumMatches: boolean;
}

function checksumSql(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function parseMigrationFilename(filename: string): { version: number; name: string } | null {
  const match = filename.match(/^(\d{3,})_([a-z0-9_]+)\.sql$/);
  if (!match) return null;
  return {
    version: Number.parseInt(match[1], 10),
    name: match[2]
  };
}

export async function loadMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(migrationsDir);
  const migrations = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.sql'))
      .map(async (filename) => {
        const parsed = parseMigrationFilename(filename);
        if (!parsed) {
          throw new Error(`Invalid migration filename: ${filename}`);
        }
        const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
        return {
          ...parsed,
          filename,
          checksum: checksumSql(sql),
          sql
        };
      })
  );
  migrations.sort((left, right) => left.version - right.version);
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index].version === migrations[index - 1].version) {
      throw new Error(`Duplicate migration version: ${migrations[index].version}`);
    }
  }
  return migrations;
}

async function migrationTableExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [MIGRATION_TABLE]);
  return result.rows[0]?.exists === true;
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(client: PoolClient): Promise<Map<number, AppliedMigration>> {
  if (!(await migrationTableExists(client))) {
    return new Map();
  }
  const result = await client.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: Date;
  }>(`SELECT version, name, checksum, applied_at FROM ${MIGRATION_TABLE} ORDER BY version ASC`);
  return new Map(
    result.rows.map((row) => [
      row.version,
      {
        version: row.version,
        name: row.name,
        checksum: row.checksum,
        appliedAt: row.applied_at
      }
    ])
  );
}

function assertAppliedChecksumsMatch(migrations: Migration[], applied: Map<number, AppliedMigration>): void {
  for (const migration of migrations) {
    const appliedMigration = applied.get(migration.version);
    if (appliedMigration && appliedMigration.checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.filename} checksum mismatch: database has ${appliedMigration.checksum}, file has ${migration.checksum}`
      );
    }
  }
}

async function withMigrationLock<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    return await work(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

export async function migrateDatabase(pool: Pool, migrationsDir?: string): Promise<Migration[]> {
  const migrations = await loadMigrations(migrationsDir);
  return withMigrationLock(pool, async (client) => {
    await ensureMigrationTable(client);
    const applied = await getAppliedMigrations(client);
    assertAppliedChecksumsMatch(migrations, applied);

    const appliedNow: Migration[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migration.checksum]
        );
        await client.query('COMMIT');
        appliedNow.push(migration);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    return appliedNow;
  });
}

export async function getMigrationStatus(pool: Pool, migrationsDir?: string): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(migrationsDir);
  const client = await pool.connect();
  try {
    const applied = await getAppliedMigrations(client);
    return migrations.map((migration) => {
      const appliedMigration = applied.get(migration.version);
      return {
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        applied: Boolean(appliedMigration),
        appliedAt: appliedMigration?.appliedAt ?? null,
        checksumMatches: !appliedMigration || appliedMigration.checksum === migration.checksum
      };
    });
  } finally {
    client.release();
  }
}

export async function assertDatabaseMigrationsCurrent(pool: Pool, migrationsDir?: string): Promise<void> {
  const status = await getMigrationStatus(pool, migrationsDir);
  const mismatched = status.find((migration) => migration.applied && !migration.checksumMatches);
  if (mismatched) {
    throw new Error(`Control-plane database migration ${mismatched.version} checksum does not match the local file`);
  }
  const pending = status.filter((migration) => !migration.applied);
  if (pending.length > 0) {
    const versions = pending.map((migration) => migration.version).join(', ');
    throw new Error(`Control-plane database has pending migrations: ${versions}. Run npm run db:migrate before startup.`);
  }
}
