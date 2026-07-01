import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const controllerSource = readFileSync(resolve('src/controllers/workspaces/target-skills-controller.ts'), 'utf8');

describe('target skills controller regression guards', () => {
  it('derives GitHub import enablement from validation status instead of request input', () => {
    const importHandler = controllerSource.slice(
      controllerSource.indexOf('export async function importTargetSkillForTarget'),
      controllerSource.indexOf('export async function getTargetSkillForTarget')
    );

    assert.match(importHandler, /const importEnabled = bundle\.validationStatus === 'valid';/);
    assert.match(importHandler, /enabled: importEnabled/);
    assert.doesNotMatch(importHandler, /Only valid imported skills can be created in the enabled state/);
    assert.doesNotMatch(importHandler, /req\.body\.enabled/);
  });
});
