import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  bootstrap,
  getRunSkillSnapshot
} from '../src/controllers/internal-execution-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  createRun,
  createSessionRecord,
  createTarget,
  createWorkspaceAiCredentialStatusResponse,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('internal execution skill snapshots', () => {
  it('bootstraps target runs with the frozen compact skill catalog', async () => {
    repo.getRun = async () => createRun({ targetId: 'vm-1', targetType: 'virtual_machine', toolAccessMode: 'read_only' });
    repo.getTarget = async () => createTarget({ id: 'vm-1', targetType: 'virtual_machine', name: 'vm' });
    repo.getSession = async () => createSessionRecord({ targetId: 'vm-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.getTargetAgentRegistration = async () => null;
    repo.getWorkspaceAiSettings = async () => null;
    repo.listTargetToolOverrides = async () => ({});
    repo.getTargetToolSetting = async () => null;
    repo.listEnabledTargetToolSettings = async () => [];
    repo.listEnabledValidTargetSkills = async () => {
      throw new Error('bootstrap must not read live target skills');
    };
    repo.getRunSkillCatalog = async () => [
      {
        ref: 'skill_1',
        skillId: 'skill-1',
        name: 'CNPG triage',
        description: 'Use when investigating CloudNativePG failover.',
        fileCount: 2,
        totalBytes: 128
      }
    ];
    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(bootstrap, createRequest({ runId: 'run-1' }));
    const skills = (response.body as {
      skills?: { contract_version: number; entries: Array<Record<string, unknown>>; load_endpoint: string };
    }).skills;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(skills, {
      contract_version: 2,
      entries: [
        {
          ref: 'skill_1',
          skill_id: 'skill-1',
          source: 'target_adapter',
          name: 'CNPG triage',
          description: 'Use when investigating CloudNativePG failover.',
          file_count: 2,
          total_bytes: 128
        }
      ],
      load_endpoint: '/internal/v1/runs/run-1/skills/{skill_ref}'
    });
  });

  it('returns frozen full skill snapshot files from the internal load endpoint', async () => {
    repo.getRunSkillSnapshot = async (runId, skillRef) => {
      assert.equal(runId, 'run-1');
      assert.equal(skillRef, 'skill_1');
      return {
        ref: 'skill_1',
        skillId: 'skill-1',
        name: 'CNPG triage',
        description: 'Use when investigating CloudNativePG failover.',
        contentHash: 'sha256:abc',
        source: { type: 'manual', syncStatus: 'not_applicable' },
        fileCount: 1,
        totalBytes: 42,
        files: [{ path: 'SKILL.md', content: 'Use this frozen skill.', sizeBytes: 42 }]
      };
    };

    const response = await callController(getRunSkillSnapshot, createRequest({ runId: 'run-1', skillRef: 'skill_1' }));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      skill_ref: 'skill_1',
      skill_id: 'skill-1',
      name: 'CNPG triage',
      description: 'Use when investigating CloudNativePG failover.',
      source: { type: 'manual', syncStatus: 'not_applicable' },
      content_hash: 'sha256:abc',
      file_count: 1,
      total_bytes: 42,
      files: [{ path: 'SKILL.md', content: 'Use this frozen skill.', size_bytes: 42 }]
    });
  });
});
