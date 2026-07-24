import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  gitImportSourceMatches,
  targetSkillImportEnabled
} from '../src/controllers/workspaces/target-skills-controller.js';
import { importTargetSkillSchema, reimportTargetSkillSchema } from '../src/types/contracts.js';

describe('target skills controller regression guards', () => {
  it('derives Git import enablement from validation status instead of request input', () => {
    assert.equal(targetSkillImportEnabled('valid'), true);
    assert.equal(targetSkillImportEnabled('invalid'), false);
    assert.equal(targetSkillImportEnabled('unvalidated'), false);
  });

  it('requires client-resolved Git snapshots for import and reimport', () => {
    const snapshotPayload = {
      files: [{ path: 'SKILL.md', content: '---\nname: Demo\ndescription: Demo skill\n---\n' }],
      source: {
        provider: 'github',
        repoUrl: 'https://github.com/acornops/skills',
        ref: 'main',
        subpath: 'skills/demo',
        commitSha: '0123456789abcdef0123456789abcdef01234567'
      }
    };

    assert.equal(importTargetSkillSchema.safeParse(snapshotPayload).success, true);
    assert.equal(reimportTargetSkillSchema.safeParse({ ...snapshotPayload, force: true }).success, true);
    assert.equal(importTargetSkillSchema.safeParse({
      ...snapshotPayload,
      source: {
        ...snapshotPayload.source,
        provider: 'gitlab',
        repoUrl: 'https://gitlab.internal/platform/skills',
        apiBaseUrl: 'https://gitlab.internal/api/v4'
      }
    }).success, true);
    assert.equal(importTargetSkillSchema.safeParse({
      ...snapshotPayload,
      source: {
        ...snapshotPayload.source,
        provider: 'gitlab',
        repoUrl: 'https://git.internal/gitlab/platform/skills',
        apiBaseUrl: 'https://git.internal/gitlab/api/v4'
      }
    }).success, true);
    assert.equal(importTargetSkillSchema.safeParse({
      ...snapshotPayload,
      source: {
        ...snapshotPayload.source,
        provider: 'gitlab',
        apiBaseUrl: 'https://gitlab.internal/api/v3'
      }
    }).success, false);
    assert.equal(importTargetSkillSchema.safeParse({ repoUrl: 'https://github.com/acornops/skills' }).success, false);
    assert.equal(importTargetSkillSchema.safeParse({
      ...snapshotPayload,
      source: { ...snapshotPayload.source, repoUrl: 'http://example.com/acornops/skills' }
    }).success, false);
    assert.equal(importTargetSkillSchema.safeParse({
      ...snapshotPayload,
      source: { ...snapshotPayload.source, subpath: '../demo' }
    }).success, false);
  });

  it('rejects reimport payloads that change the stored Git source', () => {
    const stored = {
      type: 'git_import' as const,
      provider: 'github' as const,
      repoUrl: 'https://github.com/acornops/skills',
      ref: 'main',
      subpath: 'skills/demo',
      syncStatus: 'current' as const
    };
    assert.equal(gitImportSourceMatches(stored, { ...stored }), true);
    assert.equal(gitImportSourceMatches(stored, { ...stored, ref: 'next' }), false);
    assert.equal(gitImportSourceMatches(stored, { ...stored, repoUrl: 'https://github.com/acornops/other' }), false);
  });
});
