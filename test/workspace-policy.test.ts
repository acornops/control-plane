import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWorkspacePlansConfig, parseAdminTokenDescriptors } from '../src/config-admin.js';
import { adminWorkspacePlanPatchSchema, adminWorkspaceSuspendSchema, adminWorkspaceRestoreSchema, adminWorkspaceQuotaPatchSchema } from '../src/types/contracts.js';

const plan = (executionLimits?: unknown) => JSON.stringify({ defaultPlanKey: 'default', plans: [{ key: 'default', name: 'Default', quotas: { members: 100, kubernetesClusters: 30, virtualMachines: 30 }, ...(executionLimits === undefined ? {} : { executionLimits }) }] });
test('execution pools default to explicit unbounded pairs', () => {
  assert.deepEqual((parseWorkspacePlansConfig(plan()).plans[0] as any).executionLimits, Object.fromEntries(['chat', 'agent', 'workflow', 'autoTriage', 'insights'].map(key => [key, { maxConcurrentRuns: null, maxOutstandingRuns: null }])));
});
test('execution limits reject partial, unknown, fractional and inverted pairs', () => {
  for (const limits of [{ chat: { maxConcurrentRuns: 1 } }, { bogus: {} }, { chat: { maxConcurrentRuns: 2, maxOutstandingRuns: 1 } }, { chat: { maxConcurrentRuns: 0.5, maxOutstandingRuns: 3 } }, { chat: { maxConcurrentRuns: null, maxOutstandingRuns: 3 } }]) assert.throws(() => parseWorkspacePlansConfig(plan(limits)));
});
test('policy mutation schemas preserve explicit preconditions and selected source', () => {
  const input = { planKey: 'default', reason: 'test mutation', requestId: 'request-1', expectedPolicyVersion: 2, overLimitBehavior: 'retain_existing' };
  assert.equal(adminWorkspacePlanPatchSchema.safeParse(input).success, true);
  assert.equal(adminWorkspaceSuspendSchema.safeParse({ workspaceName: 'Workspace', reason: 'private', source: 'external', publicReason: 'Contact support', requestId: 'request-2', expectedPolicyVersion: 0 }).success, true);
});
test('narrow policy machine scopes are supported', () => {
  assert.doesNotThrow(() => parseAdminTokenDescriptors(JSON.stringify([{ id: 'billing', sha256: 'a'.repeat(64), scopes: ['admin:workspace:policy:read', 'admin:workspace:plan:write', 'admin:workspace:external-hold:write'] }]), 'test'));
});

test('receipt-bearing mutations require expected version while legacy bodies remain valid', () => {
  for (const [schema, fields] of [[adminWorkspacePlanPatchSchema, { planKey: 'default' }], [adminWorkspaceSuspendSchema, { workspaceName: 'Workspace' }], [adminWorkspaceRestoreSchema, {}], [adminWorkspaceQuotaPatchSchema, { quotas: null }]] as const) {
    const body = { ...fields, reason: 'test policy' };
    assert.equal(schema.safeParse(body).success, true);
    assert.equal(schema.safeParse({ ...body, requestId: 'event' }).success, false);
    assert.equal(schema.safeParse({ ...body, requestId: 'event', expectedPolicyVersion: 0 }).success, true);
  }
});
