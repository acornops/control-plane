import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { registerVirtualMachineSchema, updateVirtualMachineSchema } from '../src/types/virtual-machine-contracts.js';
import { db } from '../src/infra/db.js';
import { getVirtualMachine, updateVirtualMachine } from '../src/store/repository-virtual-machines.js';
import { buildVirtualMachineWindowsInstallInstructions } from '../src/services/virtual-machine-windows-install-instructions.js';
import { windowsAgentVConfigSchema } from '../src/config-agentv-windows.js';

afterEach(() => mock.restoreAll());
it('accepts explicit matching Windows identity and rejects mismatched and unknown identities', () => {
  assert.equal(registerVirtualMachineSchema.safeParse({ name: 'old' }).success, true);
  assert.equal(registerVirtualMachineSchema.safeParse({ name: 'win', osFamily: 'windows', serviceManager: 'scm' }).success, true);
  for (const pair of [{ osFamily: 'windows' }, { serviceManager: 'scm' }, { osFamily: 'windows', serviceManager: 'systemd' }, { osFamily: 'plan9', serviceManager: 'scm' }]) {
    assert.equal(registerVirtualMachineSchema.safeParse({ name: 'bad', ...pair }).success, false);
  }
  assert.equal(registerVirtualMachineSchema.safeParse({ name: 'win', osFamily: 'windows', serviceManager: 'scm', agentAccessMode: 'read_write', restartServices: ['nginx.service'] }).success, false);
  assert.equal(updateVirtualMachineSchema.safeParse({ osFamily: 'linux' }).success, false);
  assert.equal(updateVirtualMachineSchema.safeParse({ serviceManager: 'scm' }).success, false);
  assert.equal(updateVirtualMachineSchema.safeParse({ name: 'legacy', futureExtension: true }).success, true);
});
it('preserves Windows identity through status and settings updates', async () => {
  let metadata: Record<string, unknown> = { osFamily: 'windows', serviceManager: 'scm' };
  mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('UPDATE targets')) metadata = JSON.parse(String(params?.[3]));
    return { rowCount: 1, rows: [{ id: 'vm', workspace_id: 'w', name: 'VM', status: 'online', metadata, created_at: new Date(), updated_at: new Date() }] };
  });
  assert.equal((await getVirtualMachine('vm'))?.osFamily, 'windows');
  assert.equal((await updateVirtualMachine('vm', { status: 'online', hostname: 'win' }))?.serviceManager, 'scm');
  assert.equal(metadata.osFamily, 'windows');
});
it('keeps Windows rollout default-off and requires independent pinned HTTPS release settings', () => {
  assert.equal(windowsAgentVConfigSchema.parse({}).AGENTV_WINDOWS_ENABLED, false);
  assert.equal(windowsAgentVConfigSchema.safeParse({ AGENTV_WINDOWS_ENABLED: 'true' }).success, false);
  for (const version of ['latest', 'v1.2.3', '1.2']) {
    assert.equal(windowsAgentVConfigSchema.safeParse({ AGENTV_WINDOWS_ENABLED: true, AGENTV_WINDOWS_RELEASE_VERSION: version, AGENTV_WINDOWS_RELEASE_BASE_URL: 'https://releases.test' }).success, false);
  }
  assert.equal(windowsAgentVConfigSchema.safeParse({ AGENTV_WINDOWS_ENABLED: true, AGENTV_WINDOWS_RELEASE_VERSION: '1.2.3', AGENTV_WINDOWS_RELEASE_BASE_URL: 'http://releases.test' }).success, false);
  assert.equal(windowsAgentVConfigSchema.safeParse({ AGENTV_WINDOWS_ENABLED: true, AGENTV_WINDOWS_RELEASE_VERSION: '1.2.3', AGENTV_WINDOWS_RELEASE_BASE_URL: 'https://releases.test' }).success, true);
});
it('builds bounded literal PowerShell bootstrap instructions with fresh-file cleanup', () => {
  const input = { targetId: 'vm-1', platformUrl: 'https://platform.test', releaseBaseUrl: 'https://releases.test', releaseVersion: '1.2.3', enrollmentToken: 'token', replaceCredential: true };
  const result = buildVirtualMachineWindowsInstallInstructions(input);
  assert.equal(result.bootstrapUrl, 'https://releases.test/v1.2.3/install-agentv.ps1');
  for (const text of ['GetTempFileName', 'finally', 'Remove-Item', "-TargetId 'vm-1'", "-EnrollmentToken 'token'", '-ReplaceCredential', '-ReleaseBaseUrl', '-PlatformUrl']) assert.ok(result.command.includes(text));
  assert.doesNotMatch(result.command, /bash|sudo/);
  assert.ok(result.command.includes("GetFolderPath('System')) 'curl.exe'"));
  assert.ok(result.command.includes("$agentvCurl -q --fail"));
  assert.ok(result.command.includes("--proto '=https' --proto-redir '=https'"));
  assert.ok(result.command.includes('--max-filesize 1048576'));
  assert.ok(result.command.includes('--max-redirs 5'));
  assert.ok(result.command.includes('$LASTEXITCODE -ne 0'));
  for (const field of ['targetId', 'platformUrl', 'releaseBaseUrl', 'releaseVersion', 'enrollmentToken'] as const) {
    assert.throws(() => buildVirtualMachineWindowsInstallInstructions({ ...input, [field]: "bad'\n;whoami" }));
  }
});

it('fails closed for explicit unknown stored platforms', async () => {
  mock.method(db, 'query', async () => ({ rowCount: 1, rows: [{ id: 'vm', metadata: { osFamily: 'windows', serviceManager: 'systemd' } }] }));
  await assert.rejects(getVirtualMachine('vm'), /Stored VM platform is invalid/);
});

it('rejects Windows registration while rollout is disabled and rejects write policy independently', async () => {
  const { addVirtualMachine } = await import('../src/store/repository-virtual-machines.js');
  const { config } = await import('../src/config.js');
  const previous = config.AGENTV_WINDOWS_ENABLED;
  try {
    config.AGENTV_WINDOWS_ENABLED = false;
    await assert.rejects(addVirtualMachine('ws', { name: 'Windows', osFamily: 'windows', serviceManager: 'scm', accessPolicy: { accessMode: 'read_only', restartServices: [] } }), /disabled or unqualified/);
    config.AGENTV_WINDOWS_ENABLED = true;
    const version = config.AGENTV_WINDOWS_RELEASE_VERSION;
    const url = config.AGENTV_WINDOWS_RELEASE_BASE_URL;
    try {
      config.AGENTV_WINDOWS_RELEASE_VERSION = '1.2.3';
      config.AGENTV_WINDOWS_RELEASE_BASE_URL = 'https://releases.test';
      await assert.rejects(addVirtualMachine('ws', { name: 'Windows', osFamily: 'windows', serviceManager: 'scm', accessPolicy: { accessMode: 'read_write', restartServices: ['nginx.service'] } }), /read-only/);
    } finally { config.AGENTV_WINDOWS_RELEASE_VERSION = version; config.AGENTV_WINDOWS_RELEASE_BASE_URL = url; }
  } finally { config.AGENTV_WINDOWS_ENABLED = previous; }
});

it('issues only PowerShell commands for Windows enrollment and repair', async () => {
  const { repo } = await import('../src/store/repository.js');
  const { config } = await import('../src/config.js');
  const { issueAgentVEnrollment, buildAgentVRepairInstructions } = await import('../src/services/agentv-enrollment.js');
  const previous = { enabled: config.AGENTV_WINDOWS_ENABLED, version: config.AGENTV_WINDOWS_RELEASE_VERSION, release: config.AGENTV_WINDOWS_RELEASE_BASE_URL, platform: config.CONTROL_PLANE_BASE_URL };
  try {
    config.AGENTV_WINDOWS_ENABLED = true;
    config.AGENTV_WINDOWS_RELEASE_VERSION = '1.2.3';
    config.AGENTV_WINDOWS_RELEASE_BASE_URL = 'https://releases.test';
    config.CONTROL_PLANE_BASE_URL = 'https://platform.test';
    mock.method(repo, 'getVirtualMachine', async () => ({ osFamily: 'windows', serviceManager: 'scm' }) as Awaited<ReturnType<typeof repo.getVirtualMachine>>);
    const create = mock.method(repo.agentv, 'createAgentVEnrollment', async () => true);
    const enrollment = await issueAgentVEnrollment({ targetId: 'vm-1', workspaceId: 'w', createdBy: 'user', purpose: 'initial', accessPolicy: { accessMode: 'read_only', restartServices: [] } });
    assert.match(enrollment!.installInstructions.command, /install-agentv.ps1/);
    assert.match(buildAgentVRepairInstructions('vm-1', 'windows').command, /install-agentv.ps1/);
    await assert.rejects(issueAgentVEnrollment({ targetId: 'vm-1', workspaceId: 'w', createdBy: 'user', purpose: 'initial', accessPolicy: { accessMode: 'read_write', restartServices: ['nginx.service'] } }), /read-only/);
    assert.equal(create.mock.callCount(), 1);
  } finally { config.AGENTV_WINDOWS_ENABLED = previous.enabled; config.AGENTV_WINDOWS_RELEASE_VERSION = previous.version; config.AGENTV_WINDOWS_RELEASE_BASE_URL = previous.release; config.CONTROL_PLANE_BASE_URL = previous.platform; }
});

it('fails closed for stored Windows write policy', async () => {
  mock.method(db, 'query', async () => ({ rowCount: 1, rows: [{ id: 'vm', metadata: { osFamily: 'windows', serviceManager: 'scm', agentAccessMode: 'read_write', restartServices: ['nginx.service'] } }] }));
  await assert.rejects(getVirtualMachine('vm'), /Windows AgentV access policy must be read-only/);
});

it('rejects PowerShell smart-quote delimiters and adjacent quote variants in both URL fields', () => {
  const input = { targetId: 'vm-1', platformUrl: 'https://platform.test', releaseBaseUrl: 'https://releases.test', releaseVersion: '1.2.3' };
  for (const quote of ['\u2018', '\u2019', '\u201a', '\u201b', '\u201c', '\u201d', '\u201e', '\u201f']) {
    const unsafeUrl = `https://releases.test/${quote};whoami;${quote}`;
    assert.equal(windowsAgentVConfigSchema.safeParse({ AGENTV_WINDOWS_RELEASE_BASE_URL: unsafeUrl }).success, false, `config accepted ${quote.codePointAt(0)?.toString(16)}`);
    for (const field of ['releaseBaseUrl', 'platformUrl'] as const) {
      assert.throws(() => buildVirtualMachineWindowsInstallInstructions({ ...input, [field]: unsafeUrl }), /literal HTTPS/, `${field} accepted ${quote.codePointAt(0)?.toString(16)}`);
    }
  }
  assert.doesNotThrow(() => buildVirtualMachineWindowsInstallInstructions({ ...input, releaseBaseUrl: 'https://releases.test/ascii-path_1.2-3', platformUrl: 'https://platform.test/acornops' }));
});
