import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { importTargetSkillSchema, reimportTargetSkillSchema } from '../src/types/contracts.js';

const controllerSource = readFileSync(resolve('src/controllers/workspaces/target-skills-controller.ts'), 'utf8');

describe('target skills controller regression guards', () => {
  it('derives Git import enablement from validation status instead of request input', () => {
    const importHandler = controllerSource.slice(
      controllerSource.indexOf('export async function importTargetSkillForTarget'),
      controllerSource.indexOf('export async function getTargetSkillForTarget')
    );

    assert.match(importHandler, /const importEnabled = bundle\.validationStatus === 'valid';/);
    assert.match(importHandler, /enabled: importEnabled/);
    assert.doesNotMatch(importHandler, /Only valid imported skills can be created in the enabled state/);
    assert.doesNotMatch(importHandler, /req\.body\.enabled/);
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
    const reimportHandler = controllerSource.slice(
      controllerSource.indexOf('export async function reimportTargetSkillForTarget'),
      controllerSource.length
    );

    assert.match(reimportHandler, /gitImportSourceMatches\(existing\.source, source\)/);
    assert.match(reimportHandler, /SOURCE_MISMATCH/);
  });
});
