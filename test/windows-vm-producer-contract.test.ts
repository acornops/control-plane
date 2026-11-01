import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildVirtualMachineWindowsInstallInstructions } from '../src/services/virtual-machine-windows-install-instructions.js';
import type { VirtualMachineInstallInstructionInput } from '../src/services/virtual-machine-install-instructions.js';
import { projectWindowsCollectionStatus, validateVirtualMachineSnapshot } from '../src/services/windows-vm-snapshot.js';
import { windowsVm } from './helpers/windows-vm-snapshot-fixtures.js';

const snapshots: Array<{ name: string; data: Record<string, unknown> }> = JSON.parse(
  readFileSync(new URL('./fixtures/windows-snapshot-contract.json', import.meta.url), 'utf8'));

// Literal consumer expectations are independent of the AgentV builder.
const expectations = [
  { name: 'healthy', host: 'ok', volumes: 'ok', services: 'ok', rows: [1, 0, 1, 1], findings: 0, coverage: ['complete', 'complete'], omitted: [0, 0] },
  { name: 'denied', host: 'ok', volumes: 'ok', services: 'permission_denied', rows: [1, 0, 1, 1], findings: 0, coverage: ['complete', 'incomplete'], omitted: [0, 0] },
  { name: 'unavailable', host: 'unavailable', volumes: 'unavailable', services: 'ok', rows: [0, 1, 1, 1], findings: 1, coverage: ['incomplete', 'complete'], omitted: [0, 0] },
  { name: 'partial', host: 'ok', volumes: 'partial', services: 'partial', rows: [1, 0, 1, 1], findings: 0, coverage: ['incomplete', 'incomplete'], omitted: [2, 0] },
  { name: 'capped', host: 'ok', volumes: 'partial', services: 'partial', rows: [50, 50, 1, 1], findings: 102, coverage: ['incomplete', 'incomplete'], omitted: [3, 4] }
];

test('the snapshot artifact contains every required producer case', () => {
  assert.deepEqual(snapshots.map(({ name }) => name), expectations.map(({ name }) => name));
});

for (const expected of expectations) test(`validates and projects real AgentV ${expected.name} output`, () => {
  const fixture = snapshots.find(({ name }) => name === expected.name);
  assert.ok(fixture, `missing ${expected.name} producer case`);
  const snapshot = { targetId: windowsVm.id, workspaceId: windowsVm.workspaceId,
    timestamp: '2026-11-01T00:00:00.000Z', data: fixture.data };
  assert.doesNotThrow(() => validateVirtualMachineSnapshot(windowsVm, snapshot));
  assert.deepEqual(['filesystems', 'degraded_services', 'top_processes', 'listeners']
    .map((key) => (fixture.data[key] as unknown[]).length), expected.rows);
  assert.equal((fixture.data.findings as unknown[]).length, expected.findings);
  assert.deepEqual(projectWindowsCollectionStatus(snapshot), {
    targetId: windowsVm.id, workspaceId: windowsVm.workspaceId, snapshotTs: snapshot.timestamp,
    categories: {
      host: { status: expected.host },
      filesystems: { status: expected.volumes, omittedCount: expected.omitted[0], findingCoverage: expected.coverage[0] },
      services: { status: expected.services, omittedCount: expected.omitted[1], findingCoverage: expected.coverage[1] },
      processes: { status: 'ok', omittedCount: 0 }, network: { status: 'ok', omittedCount: 0 }
    }
  });
  assert.throws(() => validateVirtualMachineSnapshot({ ...windowsVm, osFamily: 'linux', serviceManager: 'systemd' }, snapshot), /stored VM platform/);
  assert.throws(() => validateVirtualMachineSnapshot(windowsVm, { ...snapshot,
    data: { ...snapshot.data, command_line: 'unsupported' } }), /Invalid Windows snapshot/);
});

test('preserves unversioned Linux validation without a Windows collection projection', () => {
  const snapshot = { targetId: 'linux-vm', workspaceId: windowsVm.workspaceId, timestamp: '2026-11-01T00:00:00.000Z',
    data: { host_summary: { hostname: 'linux-host' }, degraded_services: [{ unit: 'legacy.service', active_state: 'failed' }] } };
  const original = structuredClone(snapshot);
  assert.doesNotThrow(() => validateVirtualMachineSnapshot({ ...windowsVm, osFamily: 'linux', serviceManager: 'systemd' }, snapshot));
  assert.equal(projectWindowsCollectionStatus(snapshot), null);
  assert.deepEqual(snapshot, original);
});

const commands: {
  source: string; sourceSha256: string; configurationSource: string; configurationSourceSha256: string;
  cases: Array<{ name: string; input: VirtualMachineInstallInstructionInput; command: string }>;
} = JSON.parse(readFileSync(new URL('./fixtures/windows-generated-commands.json', import.meta.url), 'utf8'));

test('the native wrapper artifact records the current producer and configuration source content', () => {
  for (const [source, hash] of [[commands.source, commands.sourceSha256], [commands.configurationSource, commands.configurationSourceSha256]]) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../${source}`, import.meta.url))).digest('hex'), hash, source);
  }
});

test('the native artifact covers initial, repair and credential replacement commands', () => {
  assert.deepEqual(commands.cases.map(({ name }) => name), ['initial', 'repair', 'replacement']);
});

for (const fixture of commands.cases) test(`builds the exact native ${fixture.name} wrapper from its recorded input`, () => {
  assert.equal(buildVirtualMachineWindowsInstallInstructions(fixture.input).command, fixture.command);
});
