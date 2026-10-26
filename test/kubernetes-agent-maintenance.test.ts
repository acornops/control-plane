import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, it, mock } from 'node:test';
import { BUILT_IN_ROLE_TEMPLATES, configureRoleTemplates } from '../src/auth/authorization.js';
import { agentGateway } from '../src/agent/ws-server.js';
import { config } from '../src/config.js';
import * as controller from '../src/controllers/workspaces/kubernetes-agent-key-controller.js';
import * as instructions from '../src/controllers/workspaces/kubernetes-cluster-request-utils.js';
import { repo } from '../src/store/repository.js';
import { callController, createCluster, createRequest, installWorkspace, restoreControllerRegressionState } from './helpers/controller-regression-fixtures.js';

afterEach(() => {
  restoreControllerRegressionState();
  configureRoleTemplates(Object.values(BUILT_IN_ROLE_TEMPLATES));
});

it('repairs an existing release without replaying credentials, configuration, or RBAC', () => {
  assert.equal(typeof instructions.buildAgentRepairInstructions, 'function');
  const result = instructions.buildAgentRepairInstructions(createCluster());
  assert.match(result.command, /^helm upgrade /);
  assert.match(result.command, /--reuse-values/);
  assert.match(result.command, /--wait/);
  assert.match(result.command, /--timeout 5m/);
  assert.match(result.command, /--devel/);
  assert.doesNotMatch(result.command, /--install|--create-namespace|config\.|rbac\.|namespaceScope|--set-file|--set-json/);
  assert.match(result.command, /podAnnotations/);
  assert.match(result.command, /\$\(date -u/);
  assert.match(result.warnings.join(' '), /context.*release.*namespace/i);
  assert.match(result.warnings.join(' '), /image.*pin/i);
});

it('quotes customized Helm arguments and evaluates the repair timestamp only on execution', () => {
  assert.equal(typeof instructions.buildAgentRepairInstructions, 'function');
  const original = { ...config };
  Object.assign(config, {
    AGENTK_HELM_RELEASE_NAME: "operator's-agent",
    AGENTK_HELM_CHART_REF: 'oci://example.test/a;echo unsafe',
    AGENTK_HELM_NAMESPACE: 'custom namespace',
    AGENTK_HELM_CHART_VERSION: '1.2.3',
    AGENTK_HELM_VALUES: { image: { tag: 'not-replayed' } },
    AGENTK_HELM_ADDITIONAL_CA_FILE_PATH: '/not/replayed.pem'
  });
  try {
    const { command } = instructions.buildAgentRepairInstructions(createCluster());
    const execution = spawnSync('bash', ['-c', `helm() { printf '%s\\n' "$@"; }; date() { printf '2026-10-26T00:00:00Z'; }; ${command}`], { encoding: 'utf8' });
    assert.equal(execution.status, 0, execution.stderr);
    assert.deepEqual(execution.stdout.trim().split('\n'), [
      'upgrade', "operator's-agent", 'oci://example.test/a;echo unsafe',
      '--version', '1.2.3', '--namespace', 'custom namespace', '--reuse-values',
      '--set-string', 'podAnnotations.acornops\\.dev/maintenance-at=2026-10-26T00:00:00Z',
      '--wait', '--timeout', '5m'
    ]);
  } finally {
    Object.assign(config, original);
  }
});

it('allows target managers to get maintenance instructions without key-management permission or side effects', async () => {
  assert.equal(typeof controller.getClusterInstallInstructions, 'function');
  configureRoleTemplates([{
    ...BUILT_IN_ROLE_TEMPLATES.admin,
    capabilities: BUILT_IN_ROLE_TEMPLATES.admin.capabilities.filter((capability) => capability !== 'manage_agent_keys')
  }]);
  installWorkspace('admin');
  mock.method(repo, 'getTargetAgentRegistration', async () => ({ agentKeyHash: 'private-hash', keyVersion: 2 }));
  const rotation = mock.method(repo, 'rotateTargetAgentKey', async () => { throw new Error('must not rotate'); });
  const disconnect = mock.method(agentGateway, 'disconnectCluster', async () => { throw new Error('must not disconnect'); });
  const audit = mock.method(repo, 'insertWorkspaceAuditEvent', async () => { throw new Error('must not mutate'); });
  const response = await callController(controller.getClusterInstallInstructions, createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = response.body as { clusterId: string; installInstructions: { command: string; warnings: string[] } };
  assert.equal(body.clusterId, 'cluster-1');
  assert.match(body.installInstructions.command, /--reuse-values/);
  assert.doesNotMatch(JSON.stringify(body), /private-hash|agentKey|keyVersion/);
  assert.equal(rotation.mock.callCount(), 0);
  assert.equal(disconnect.mock.callCount(), 0);
  assert.equal(audit.mock.callCount(), 0);
});

it('rejects readers, cross-workspace targets, missing targets, and missing registrations', async () => {
  assert.equal(typeof controller.getClusterInstallInstructions, 'function');
  installWorkspace('viewer');
  const request = createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' });
  assert.equal((await callController(controller.getClusterInstallInstructions, request)).statusCode, 403);
  installWorkspace('admin');
  assert.equal((await callController(controller.getClusterInstallInstructions, createRequest({ workspaceId: 'another-workspace', clusterId: 'cluster-1' }))).statusCode, 404);
  assert.equal((await callController(controller.getClusterInstallInstructions, createRequest({ workspaceId: 'workspace-1', clusterId: 'missing' }))).statusCode, 404);
  mock.method(repo, 'getTargetAgentRegistration', async () => null);
  assert.equal((await callController(controller.getClusterInstallInstructions, request)).statusCode, 409);
});
