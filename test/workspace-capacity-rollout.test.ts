import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { assertWorkspaceCapacityRollout, workspaceCatalogFingerprint } from '../src/services/workspace-capacity-rollout.js';

const original = { enabled: config.WORKSPACE_CAPACITY_ENABLED, admission: config.WORKSPACE_ADMISSION_ENABLED,
  dispatch: config.WORKSPACE_DISPATCH_ENABLED, plans: config.WORKSPACE_PLANS };
afterEach(() => {
  config.WORKSPACE_CAPACITY_ENABLED = original.enabled;
  config.WORKSPACE_ADMISSION_ENABLED = original.admission;
  config.WORKSPACE_DISPATCH_ENABLED = original.dispatch;
  config.WORKSPACE_PLANS = original.plans;
  mock.restoreAll();
});

describe('workspace capacity rollout startup', () => {
  it('fails closed for mode, catalogue and unverified activation mismatches', async () => {
    config.WORKSPACE_CAPACITY_ENABLED = true;
    config.WORKSPACE_ADMISSION_ENABLED = true;
    config.WORKSPACE_DISPATCH_ENABLED = true;
    const state = { active: false, catalog_hash: workspaceCatalogFingerprint(), verified_at: new Date() as Date | null };
    mock.method(db, 'query', async () => ({ rowCount: 1, rows: [state] }));
    await assert.rejects(assertWorkspaceCapacityRollout(), /mode differs/);
    state.active = true;
    state.verified_at = null;
    await assert.rejects(assertWorkspaceCapacityRollout(), /not passed/);
    state.verified_at = new Date();
    state.catalog_hash = 'different';
    await assert.rejects(assertWorkspaceCapacityRollout(), /catalogue differs/);
    state.catalog_hash = workspaceCatalogFingerprint();
    await assert.doesNotReject(assertWorkspaceCapacityRollout());
  });
  it('allows mode changes only while both admission and dispatch are closed', async () => {
    config.WORKSPACE_CAPACITY_ENABLED = true;
    mock.method(db, 'query', async () => ({ rowCount: 1, rows: [{ active: false, catalog_hash: null, verified_at: null }] }));
    config.WORKSPACE_ADMISSION_ENABLED = false;
    config.WORKSPACE_DISPATCH_ENABLED = true;
    await assert.rejects(assertWorkspaceCapacityRollout(), /mode differs/);
    config.WORKSPACE_DISPATCH_ENABLED = false;
    await assert.doesNotReject(assertWorkspaceCapacityRollout());
  });
  it('catalogue fingerprints ignore display names and order but include limits', () => {
    const fingerprint = workspaceCatalogFingerprint();
    config.WORKSPACE_PLANS = { ...original.plans, plans: original.plans.plans.map(plan => ({ ...plan, name: 'New display name' })).reverse() };
    assert.equal(workspaceCatalogFingerprint(), fingerprint);
    const plan = config.WORKSPACE_PLANS.plans[0];
    config.WORKSPACE_PLANS = { ...config.WORKSPACE_PLANS, plans: [{ ...plan, quotas: { ...plan.quotas, members: 12345 } }] };
    assert.notEqual(workspaceCatalogFingerprint(), fingerprint);
  });
});
