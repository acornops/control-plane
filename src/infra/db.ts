import { Pool } from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { assertDatabaseMigrationsCurrent } from './migrations.js';

export const db = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: config.NODE_ENV === 'test'
});

export async function initializeDatabase(): Promise<void> {
  await assertDatabaseMigrationsCurrent(db);
  logger.info('PostgreSQL schema migrations current');
}

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    await assertDatabaseMigrationsCurrent(db);
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await db.end();
}
