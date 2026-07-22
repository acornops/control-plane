import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { updateTargetToolSettings } from '../src/controllers/workspaces/target-native-tool-controller.js';
import { resolveTargetRunTools } from '../src/services/target-run-tool-resolution.js';
import { webhooks } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

function installResolverRepoStubs(): void {
  repo.getTargetAgentRegistration = async () => ({
    workspaceId: 'workspace-1',
    targetId: 'target-1',
    targetType: 'virtual_machine',
    agentKeyHash: 'hash',
    keyVersion: 1,
    capabilities: ['read', 'write']
  });
  repo.listTargetToolOverrides = async () => ({});
  repo.listEnabledTargetToolSettings = async () => [];
  repo.listEnabledValidTargetSkills = async () => [];
  repo.listEnabledValidTargetSkillSummaries = async () => [];
  repo.listMatchingWebhookSubscriptions = async () => [];
}

function mockEmptyToolList(): void {
  mock.method(globalThis, 'fetch', async (input) => String(input).includes('/api/v1/internal/mcp/tools?')
    ? new Response(JSON.stringify([]), { status: 200 })
    : new Response('unexpected request', { status: 500 }));
}

describe('target native tool toggleability', () => {
  it('persists PDF report enablement without exposing internal tool instructions', async () => {
    installWorkspace('admin');
    let persisted: { toolId: string; enabled: boolean; config: Record<string, unknown> } | null = null;
    repo.upsertTargetToolSetting = async (targetId, toolId, enabled, config) => {
      persisted = { toolId, enabled, config };
      return { targetId, toolId, enabled, config, updatedAt: '2026-05-24T00:00:00.000Z' };
    };
    mock.method(webhooks, 'emit', () => undefined);

    const response = await callController(
      updateTargetToolSettings,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1', toolId: 'reports.pdf.generate' },
        { enabled: false }
      )
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(persisted, {
      toolId: 'reports.pdf.generate',
      enabled: false,
      config: { authorizationClass: 'internal_artifact' }
    });
    assert.equal((response.body as { enabled: boolean }).enabled, false);
    assert.equal((response.body as { toggleable: boolean }).toggleable, true);
    assert.equal(
      (response.body as { description: string }).description,
      'Create a provenance-linked PDF incident report from the current assistant conversation and available evidence.'
    );
  });

  it('excludes PDF report generation from target Assistant runs when disabled', async () => {
    installResolverRepoStubs();
    repo.getTargetToolSetting = async (_targetId, toolId) => toolId === 'reports.pdf.generate'
      ? {
          targetId: 'target-1',
          toolId,
          enabled: false,
          config: { authorizationClass: 'internal_artifact' },
          updatedAt: '2026-05-24T00:00:00.000Z'
        }
      : null;
    mockEmptyToolList();

    const result = await resolveTargetRunTools({
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      targetType: 'virtual_machine',
      toolAccessMode: 'read_only',
      runId: 'run-1'
    });

    assert.deepEqual(result.platformFunctions, []);
    assert.equal(result.allowedToolNames.includes('acornops_generate_pdf_report'), false);
    assert.equal(result.previewItems.some((item) => item.id === 'reports.pdf.generate'), false);
  });
});
