import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  BUILT_IN_ROLE_TEMPLATES,
  configureRoleTemplates
} from '../src/auth/authorization.js';
import {
  startExistingTargetAutoTriageInvestigations,
  updateTargetAutoTriage
} from '../src/controllers/workspaces/auto-triage-controller.js';
import { repo } from '../src/store/repository.js';
import type { TargetAutoTriageSettings } from '../src/types/auto-triage.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

const savedSettings: TargetAutoTriageSettings = {
  workspaceId: 'workspace-1',
  targetId: 'cluster-1',
  enabled: true,
  minimumSeverity: 'warning',
  writeMode: 'approval_required',
  additionalInstructions: '',
  namespaceInclude: [],
  namespaceExclude: [],
  includeClusterScopedIssues: true,
  revision: 1
};
const originalAutoTriageRepository = repo.autoTriage;

afterEach(() => {
  repo.autoTriage = originalAutoTriageRepository;
  restoreControllerRegressionState();
  configureRoleTemplates(Object.values(BUILT_IN_ROLE_TEMPLATES));
});

function installTargetManagerWithoutWriteRuns(): void {
  configureRoleTemplates([
    ...Object.values(BUILT_IN_ROLE_TEMPLATES),
    {
      key: 'target-manager',
      displayName: 'Target Manager',
      description: 'Manages targets without authorizing read/write runs.',
      kind: 'custom',
      capabilities: ['read_workspace_data', 'manage_targets', 'create_sessions', 'create_read_only_runs'],
      protected: false,
      sortOrder: 900
    }
  ]);
  installWorkspace('target-manager');
}

describe('target auto-triage controller authorization', () => {
  it('requires target management before changing settings', async () => {
    installWorkspace('operator');

    const response = await callController(
      updateTargetAutoTriage,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1' },
        {
          expectedRevision: 0,
          enabled: true,
          minimumSeverity: 'warning',
          writeMode: 'read_only',
          additionalInstructions: ''
        }
      )
    );

    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: { code: string } }).error.code, 'FORBIDDEN');
  });

  it('requires read/write-run permission for every write-capable saved mode', async () => {
    installTargetManagerWithoutWriteRuns();

    const response = await callController(
      updateTargetAutoTriage,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1' },
        {
          expectedRevision: 1,
          enabled: true,
          minimumSeverity: 'warning',
          writeMode: 'follow_target',
          additionalInstructions: ''
        }
      )
    );

    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: { code: string } }).error.code, 'FORBIDDEN');
  });

  it('allows a target-only manager to submit diagnose-only settings', async () => {
    installTargetManagerWithoutWriteRuns();
    repo.autoTriage = {
      ...originalAutoTriageRepository,
      getTargetAutoTriageSettings: async () => ({
        ...savedSettings,
        writeMode: 'read_only'
      }),
      saveTargetAutoTriageSettings: async () => null
    };

    const response = await callController(
      updateTargetAutoTriage,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1' },
        {
          expectedRevision: 1,
          enabled: true,
          minimumSeverity: 'warning',
          writeMode: 'read_only',
          additionalInstructions: ''
        }
      )
    );

    assert.equal(response.statusCode, 409);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      'AUTO_TRIAGE_SETTINGS_CONFLICT'
    );
  });

  it('rejects Kubernetes namespace eligibility settings for virtual machines', async () => {
    installWorkspace('owner');

    const response = await callController(
      updateTargetAutoTriage,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'target-1' },
        {
          expectedRevision: 0,
          enabled: true,
          minimumSeverity: 'warning',
          writeMode: 'read_only',
          additionalInstructions: '',
          namespaceInclude: ['payments'],
          namespaceExclude: [],
          includeClusterScopedIssues: true
        }
      )
    );

    assert.equal(response.statusCode, 400);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      'VALIDATION_ERROR'
    );
  });

  it('checks the saved write mode before bulk-queueing existing issues', async () => {
    installTargetManagerWithoutWriteRuns();
    repo.autoTriage = {
      ...originalAutoTriageRepository,
      getTargetAutoTriageSettings: async () => savedSettings
    };

    const response = await callController(
      startExistingTargetAutoTriageInvestigations,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1' },
        { expectedSettingsRevision: 1 }
      )
    );

    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: { code: string } }).error.code, 'FORBIDDEN');
  });
});
