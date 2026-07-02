import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));

test('contract check fails when management-console service code calls an undocumented API path', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'acornops-mc-contract-'));
  try {
    const serviceDir = path.join(fixtureRoot, 'src/services/control-plane');
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      path.join(serviceDir, 'fixtureApi.ts'),
      "export const missing = requestJson('/api/v1/frontend-only');\n",
      'utf8'
    );

    const result = spawnSync('node', ['scripts/check-contracts.mjs'], {
      cwd: path.resolve(testDir, '..'),
      env: {
        ...process.env,
        ACORNOPS_MANAGEMENT_CONSOLE_ROOT: fixtureRoot
      },
      encoding: 'utf8'
    });

    if (result.error && 'code' in result.error && result.error.code === 'EPERM') {
      t.skip('sandbox does not allow spawning node from this test');
      return;
    }
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /frontend-only/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
