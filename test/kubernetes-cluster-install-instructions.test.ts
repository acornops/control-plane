import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAgentInstallInstructions,
  parseAgentAccessMode
} from '../src/controllers/workspaces/kubernetes-cluster-request-utils.js';
import { parseAgentKHelmValues, type AgentKHelmValues } from '../src/config-agentk-helm.js';
import { config, parseAppConfig } from '../src/config.js';
import { registerClusterSchema } from '../src/types/contracts.js';
import type { KubernetesCluster } from '../src/types/domain.js';

const cluster: KubernetesCluster = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  name: 'payments-prod',
  status: 'unknown',
  namespaceInclude: ['payments', 'shared'],
  namespaceExclude: ['sandbox'],
  writeConfirmationPolicy: {
    effectiveRequired: true,
    overrideRequired: null,
    source: 'deployment_default'
  },
  createdAt: '2026-06-30T00:00:00.000Z',
  updatedAt: '2026-06-30T00:00:00.000Z'
};

const mutableConfig = config as typeof config & {
  AGENTK_HELM_CHART_VERSION?: string;
  AGENTK_HELM_VALUES: AgentKHelmValues;
  AGENTK_HELM_ADDITIONAL_CA_FILE_PATH?: string;
};

describe('Kubernetes cluster install instructions', () => {
  it('keeps generated install commands read-only by default', () => {
    const instructions = buildAgentInstallInstructions(cluster, 'agent-key');

    assert.equal(instructions.releaseName, 'acornops-agentk');
    assert.equal(instructions.namespace, 'acornops-agentk');
    assert.match(instructions.command, /^helm upgrade --install 'acornops-agentk'/);
    assert.match(instructions.command, /--namespace 'acornops-agentk'/);
    assert.doesNotMatch(instructions.command, /rbac\.write\.enabled=true/);
    assert.match(instructions.command, /--devel/);
    assert.doesNotMatch(instructions.command, /--version/);
    assert.match(instructions.command, /--set-string config\.agentKey='agent-key'/);
    assert.match(instructions.command, /--set-json namespaceScope\.include='\["payments","shared"\]'/);
    assert.match(instructions.command, /--set-json namespaceScope\.exclude='\["sandbox"\]'/);
    assert.doesNotMatch(instructions.command, /config\.watchNamespaces/);
  });

  it('pins the chart only when a version is configured', () => {
    const previousVersion = mutableConfig.AGENTK_HELM_CHART_VERSION;
    mutableConfig.AGENTK_HELM_CHART_VERSION = '0.0.1-experimental.4';
    try {
      const instructions = buildAgentInstallInstructions(cluster, 'agent-key');

      assert.match(instructions.command, /--version '0\.0\.1-experimental\.4'/);
      assert.doesNotMatch(instructions.command, /--devel/);
    } finally {
      mutableConfig.AGENTK_HELM_CHART_VERSION = previousVersion;
    }
  });

  it('adds configured chart values and an operator-local CA file safely', () => {
    const previousValues = mutableConfig.AGENTK_HELM_VALUES;
    const previousCaFilePath = mutableConfig.AGENTK_HELM_ADDITIONAL_CA_FILE_PATH;
    mutableConfig.AGENTK_HELM_VALUES = {
      image: {
        repository: 'docker.artifact.internal.org/ghcr.io/acornops/agentk',
        tag: '0.0.1-experimental.7'
      },
      imagePullSecrets: [{ name: 'internal-registry' }]
    };
    mutableConfig.AGENTK_HELM_ADDITIONAL_CA_FILE_PATH = "/opt/acornops trust/org,team's-ca.pem";
    try {
      const instructions = buildAgentInstallInstructions(cluster, 'agent-key');

      assert.match(
        instructions.command,
        /--set-json image='{"repository":"docker\.artifact\.internal\.org\/ghcr\.io\/acornops\/agentk","tag":"0\.0\.1-experimental\.7"}'/
      );
      assert.match(
        instructions.command,
        /--set-json imagePullSecrets='\[{"name":"internal-registry"}\]'/
      );
      assert.ok(
        instructions.command.includes(
          "--set-file config.tls.additionalCaBundle.inlinePem='/opt/acornops trust/org\\,team'\\''s-ca.pem'"
        ),
        'CA file path should be escaped for Helm parsing and shell execution'
      );
      assert.ok(
        instructions.command.indexOf('--set-json image=') < instructions.command.indexOf('--set-string config.agentKey='),
        'control-plane-owned values should be rendered after platform defaults'
      );
    } finally {
      mutableConfig.AGENTK_HELM_VALUES = previousValues;
      mutableConfig.AGENTK_HELM_ADDITIONAL_CA_FILE_PATH = previousCaFilePath;
    }
  });

  it('parses safe downstream chart values and rejects owned paths', () => {
    assert.deepEqual(
      parseAgentKHelmValues('{"image":{"repository":"registry.internal/agentk"},"replicaCount":2}'),
      { image: { repository: 'registry.internal/agentk' }, replicaCount: 2 }
    );
    assert.throws(
      () => parseAgentKHelmValues('{"config":{"agentKey":"override"}}'),
      /must not override control-plane-owned value config\.agentKey/
    );
    assert.throws(
      () => parseAgentKHelmValues('{"rbac":{"write":{"enabled":true}}}'),
      /must not override control-plane-owned value rbac\.write\.enabled/
    );
    assert.throws(
      () => parseAgentKHelmValues('{"bad.key":true}'),
      /contains an invalid top-level key/
    );
  });

  it('loads generated install defaults from the control-plane environment', () => {
    const parsed = parseAppConfig({
      NODE_ENV: 'test',
      AGENTK_HELM_VALUES_JSON: '{"image":{"repository":"registry.internal/agentk"}}',
      AGENTK_HELM_ADDITIONAL_CA_FILE_PATH: '/opt/acornops/ca.pem'
    });

    assert.deepEqual(parsed.AGENTK_HELM_VALUES, {
      image: { repository: 'registry.internal/agentk' }
    });
    assert.equal(parsed.AGENTK_HELM_ADDITIONAL_CA_FILE_PATH, '/opt/acornops/ca.pem');
  });

  it('rejects conflicting CA sources and malformed values JSON', () => {
    assert.throws(
      () => parseAgentKHelmValues('{"config":{"tls":{"additionalCaBundle":{"configMapKeyRef":{"name":"ca","key":"ca.crt"}}}}}', '/ca.pem'),
      /must not configure config\.tls\.additionalCaBundle/
    );
    assert.throws(() => parseAgentKHelmValues('[]'), /must be a JSON object/);
    assert.throws(() => parseAgentKHelmValues('{'), /must be valid JSON/);
    assert.throws(
      () => parseAppConfig({ NODE_ENV: 'test', AGENTK_HELM_VALUES_JSON: '{' }),
      /AGENTK_HELM_VALUES_JSON must be valid JSON/
    );
  });

  it('adds the chart write RBAC flag for read-write installs', () => {
    const instructions = buildAgentInstallInstructions(cluster, 'agent-key', 'read_write');

    assert.match(instructions.command, /--set rbac\.write\.enabled=true/);
  });

  it('parses unknown access modes as read-only', () => {
    assert.equal(parseAgentAccessMode('read_write'), 'read_write');
    assert.equal(parseAgentAccessMode('read_only'), 'read_only');
    assert.equal(parseAgentAccessMode('admin'), 'read_only');
    assert.equal(parseAgentAccessMode(undefined), 'read_only');
  });

  it('preserves agent access mode through registration body validation', () => {
    const parsed = registerClusterSchema.parse({
      name: 'payments-prod',
      agentAccessMode: 'read_write',
      namespaceInclude: ['payments'],
      namespaceExclude: ['sandbox']
    });

    assert.equal(parsed.agentAccessMode, 'read_write');
  });

  it('rejects namespace policy values AgentK cannot safely enforce', () => {
    assert.equal(registerClusterSchema.safeParse({
      name: 'invalid', namespaceInclude: ['INVALID']
    }).success, false);
    assert.equal(registerClusterSchema.safeParse({
      name: 'duplicate', namespaceInclude: ['payments', 'payments']
    }).success, false);
  });

  it('lets controller defaulting handle unknown registration access modes', () => {
    const parsed = registerClusterSchema.parse({
      name: 'payments-prod',
      agentAccessMode: 'admin'
    });

    assert.equal(parseAgentAccessMode(parsed.agentAccessMode), 'read_only');
  });
});
