import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getTargetSkillBundleStorageLimitErrors,
  normalizeTargetSkillBundle,
  TARGET_SKILL_MAX_FILE_BYTES,
  TARGET_SKILL_MAX_FILES,
  TARGET_SKILL_MAX_TOTAL_BYTES,
  type TargetSkillBundleFileInput
} from '../../src/services/target-skills.js';

function skillFile(content = '---\nname: Test skill\ndescription: Test skill.\n---\n'): TargetSkillBundleFileInput {
  return { path: 'SKILL.md', content };
}

describe('target skill bundle storage limits', () => {
  it('accepts user-defined Markdown paths outside references', () => {
    const bundle = normalizeTargetSkillBundle([
      skillFile(),
      { path: 'CNPG Runbooks/Primary Notes.md', content: '# Primary notes\n' },
      { path: 'Escalation.md', content: '# Escalation\n' }
    ]);

    assert.equal(bundle.validationStatus, 'valid');
    assert.deepEqual(bundle.files.map((file) => file.path), [
      'SKILL.md',
      'CNPG Runbooks/Primary Notes.md',
      'Escalation.md'
    ]);
  });

  it('flags bundles that exceed the persisted file count limit', () => {
    const files = [
      skillFile(),
      ...Array.from({ length: TARGET_SKILL_MAX_FILES }, (_value, index) => ({
        path: `refs/file-${index}.md`,
        content: '# Reference\n'
      }))
    ];

    const bundle = normalizeTargetSkillBundle(files);
    assert.deepEqual(getTargetSkillBundleStorageLimitErrors(bundle), [
      `Skill bundle can include at most ${TARGET_SKILL_MAX_FILES} Markdown files.`
    ]);
  });

  it('flags bundles that exceed persisted total and per-file byte limits', () => {
    const oversizedContent = 'x'.repeat(TARGET_SKILL_MAX_FILE_BYTES + 1);
    const bundle = normalizeTargetSkillBundle([
      skillFile(),
      { path: 'refs/large.md', content: oversizedContent },
      { path: 'refs/also-large.md', content: 'y'.repeat(TARGET_SKILL_MAX_TOTAL_BYTES) }
    ]);

    assert.deepEqual(getTargetSkillBundleStorageLimitErrors(bundle), [
      `Skill bundle exceeds the ${TARGET_SKILL_MAX_TOTAL_BYTES} byte limit.`,
      `Skill file "refs/also-large.md" exceeds the ${TARGET_SKILL_MAX_FILE_BYTES} byte limit.`,
      `Skill file "refs/large.md" exceeds the ${TARGET_SKILL_MAX_FILE_BYTES} byte limit.`
    ]);
  });
});
