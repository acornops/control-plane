import assert from 'node:assert/strict';
import { config } from '../../src/config.js';
import { db } from '../../src/infra/db.js';

function assertIsolatedTestDatabase(): void {
  const explicitTestUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
  assert.equal(process.env.NODE_ENV, 'test', 'automation database fixtures require NODE_ENV=test');
  assert.ok(explicitTestUrl, 'automation database fixtures require CONTROL_PLANE_TEST_DATABASE_URL');
  assert.equal(config.DATABASE_URL, explicitTestUrl, 'DATABASE_URL must match CONTROL_PLANE_TEST_DATABASE_URL');

  const databaseName = new URL(explicitTestUrl).pathname.replace(/^\//, '');
  assert.match(databaseName, /(?:^|[_-])test(?:$|[_-])/, 'automation fixtures require an explicitly named test database');
}

export async function resetAutomationDatabaseFixtures(): Promise<void> {
  assertIsolatedTestDatabase();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE workspaces CASCADE');
    await client.query(
      `INSERT INTO users (id,email,display_name)
       VALUES ('user-1','user-1@example.test','Test User')
       ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name`
    );
    await client.query(
      `INSERT INTO workspaces (id,name,created_by)
       VALUES ('workspace-1','Test Workspace','user-1'),('workspace-2','Other Test Workspace','user-1')`
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closeAutomationDatabaseFixtures(): Promise<void> {
  await db.end();
}
