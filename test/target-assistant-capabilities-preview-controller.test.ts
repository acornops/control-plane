import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getTargetAssistantCapabilitiesPreview } from '../src/controllers/workspaces/target-assistant-preview-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  createTarget,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  BASE_TOOLS,
  installResolverRepoStubs,
  mockToolList
} from './helpers/target-run-tool-resolution-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('target assistant capabilities preview controller', () => {
  it('returns the shared resolver preview for an allowed target run mode', async () => {
    installWorkspace('operator');
    repo.getTarget = async () => createTarget({ id: 'target-1', name: 'vm', targetType: 'virtual_machine' });
    installResolverRepoStubs(['read', 'write']);
    repo.listEnabledValidTargetSkills = async () => {
      throw new Error('capabilities preview must not load full skill files');
    };
    repo.listEnabledValidTargetSkillSummaries = async () => [
      {
        id: 'skill-1',
        workspaceId: 'workspace-1',
        targetId: 'target-1',
        targetType: 'virtual_machine',
        name: 'CNPG triage',
        description: 'Use when investigating CloudNativePG failover.',
        enabled: true,
        source: { type: 'manual', syncStatus: 'not_applicable' },
        bundleStats: { fileCount: 1, totalBytes: 15 },
        validationStatus: 'valid',
        validationErrors: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
      }
    ];
    mockToolList(BASE_TOOLS);
    const req = Object.assign(createRequest({ workspaceId: 'workspace-1', targetId: 'target-1' }), {
      query: { toolAccessMode: 'read_only' }
    });

    const response = await callController(getTargetAssistantCapabilitiesPreview, req);
    const body = response.body as {
      toolAccessMode: string;
      toolSummary: { totalAllowed: number; writeAllowed: number };
      skillSummary: { totalAvailable: number };
      tools: Array<{ id: string; runtimeKind: string; input_schema?: unknown }>;
      skills: Array<{ id: string; name: string; description: string; source: string }>;
    };

    assert.equal(response.statusCode, 200);
    assert.equal(body.toolAccessMode, 'read_only');
    assert.equal(body.toolSummary.totalAllowed, 4);
    assert.equal(body.toolSummary.writeAllowed, 0);
    assert.equal(body.skillSummary.totalAvailable, 1);
    assert.deepEqual(body.tools.map((item) => item.id), ['reports.pdf.generate', 'query_logs', 'target_insights', 'web_search']);
    assert.equal(body.tools.some((item) => Object.prototype.hasOwnProperty.call(item, 'input_schema')), false);
    assert.deepEqual(body.skills, [
      {
        id: 'skill-1',
        name: 'CNPG triage',
        description: 'Use when investigating CloudNativePG failover.',
        source: 'manual'
      }
    ]);
  });
});
