import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePlatformSettingsDeploymentPolicy } from '../src/config-platform-settings.js';
import { kubernetesRbacAdditionResourceSchema, kubernetesRbacAdditionSchema, kubernetesRbacAdditionsValueSchema } from '../src/services/kubernetes-rbac-additions.js';
import { createTargetSkillSchema } from '../src/types/target-skill-contracts.js';
import { updateTargetInsightsEntrySchema } from '../src/types/target-insights-contracts.js';
import { adminPlatformSettingPatchSchema, toolApprovalExecutionFinishedSchema, toolResultArtifactCreateSchema } from '../src/types/contracts.js';
import { registerVirtualMachineSchema, updateVirtualMachineSchema } from '../src/types/virtual-machine-contracts.js';

for (const { name, schema, input, field, limit } of [
  { name: 'VM log sources', schema: registerVirtualMachineSchema, input: { name: 'vm' }, field: 'allowedLogSources', limit: 10 },
  { name: 'VM restart allowlist', schema: registerVirtualMachineSchema, input: { name: 'vm', agentAccessMode: 'read_write' }, field: 'restartServices', limit: 32 },
  { name: 'skill files', schema: createTargetSkillSchema, input: {}, field: 'files', limit: 16 },
  { name: 'RBAC profiles', schema: kubernetesRbacAdditionsValueSchema, input: {}, field: 'additions', limit: 25 },
  { name: 'nested RBAC resources', schema: kubernetesRbacAdditionSchema, input: { key: 'widgets', name: 'Widgets' }, field: 'resources', limit: 50 },
  { name: 'nested RBAC verbs', schema: kubernetesRbacAdditionResourceSchema, input: { apiGroup: 'example.test', apiVersion: 'v1', resource: 'widgets', kind: 'Widget', scope: 'namespaced' }, field: 'verbs', limit: 6 }
]) {
  test(`${name} reject excess items before reading or validating elements`, () => {
    let reads = 0;
    const items = Array.from({ length: limit + 1 }, () => null);
    for (let index = 0; index < items.length; index++) {
      Object.defineProperty(items, index, { get() { reads++; return null; } });
    }
    const result = schema.safeParse({ ...input, [field]: items });
    assert.equal(result.success, false);
    assert.equal(reads, 0, 'oversized collections must not traverse their items');
    if (result.success) return;
    assert.equal(result.error.issues.length, 1);
    assert.equal(result.error.issues[0].code, 'too_big');
    assert.deepEqual(result.error.issues[0].path, [field]);
  });
}

test('deployment policy fills nested defaults without changing the sign-in policy', () => {
  assert.deepEqual(resolvePlatformSettingsDeploymentPolicy(undefined, ['password']), {
    memberDiscovery: { allowedModes: ['disabled', 'exact_email'], defaultMode: 'exact_email' },
    aiPolicy: { runtimeEditable: true, allowAdditionalModels: false },
    userSignInMethods: { allowedMethods: ['password'], defaultMethods: ['password'] },
    kubernetesRbacAdditions: { runtimeEditable: true, profiles: [] }
  });
});

test('partial insight updates do not reactivate an entry through the create default', () => {
  assert.deepEqual(updateTargetInsightsEntrySchema.parse({ title: 'Renamed' }), { title: 'Renamed' });
  assert.equal(updateTargetInsightsEntrySchema.safeParse({}).success, false);
  assert.deepEqual(updateTargetInsightsEntrySchema.parse({ status: 'archived' }), { status: 'archived' });
});

test('VM registration remains read-only by default and updates preserve omission', () => {
  assert.deepEqual(registerVirtualMachineSchema.parse({ name: 'vm' }), {
    name: 'vm', agentAccessMode: 'read_only', restartServices: []
  });
  assert.deepEqual(updateVirtualMachineSchema.parse({ name: 'renamed' }), { name: 'renamed' });
  assert.equal(registerVirtualMachineSchema.safeParse({ name: 'vm', agentAccessMode: 'read_write' }).success, false);
});

test('legacy arbitrary payloads preserve omission while artifact results remain mandatory', () => {
  assert.deepEqual(toolApprovalExecutionFinishedSchema.parse({}), { isError: false });
  assert.deepEqual(toolApprovalExecutionFinishedSchema.parse({ result: null }), { result: null, isError: false });
  assert.deepEqual(adminPlatformSettingPatchSchema.parse({ reason: 'Policy maintenance', expectedVersion: 0 }), { reason: 'Policy maintenance', expectedVersion: 0 });
  assert.equal(toolResultArtifactCreateSchema.safeParse({ callId: 'call-1', toolName: 'list_resources' }).success, false);
});
