import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, it, mock } from 'node:test';
import { config } from '../../src/config.js';
import { GithubSkillImportError, importTargetSkillFromGithub } from '../../src/services/github-skill-import.js';

const mutableConfig = config as typeof config & {
  GITHUB_IMPORT_TOKEN?: string;
};
const originalGithubImportToken = config.GITHUB_IMPORT_TOKEN;

afterEach(() => {
  mutableConfig.GITHUB_IMPORT_TOKEN = originalGithubImportToken;
  mock.restoreAll();
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function encodeContent(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

function binaryResponse(payload: Buffer, status = 200): Response {
  return new Response(payload, { status });
}

function createTarGz(files: Array<{ path: string; content: string }>): Buffer {
  const records: Buffer[] = [];
  for (const file of files) {
    const content = Buffer.from(file.content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(file.path, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(' ', 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    records.push(header, content);
    const paddingSize = (512 - (content.length % 512)) % 512;
    if (paddingSize > 0) {
      records.push(Buffer.alloc(paddingSize));
    }
  }
  records.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(records));
}

describe('github skill import', () => {
  it('ignores non-Markdown repository files while importing the Markdown skill snapshot', async () => {
    const fetchedUrls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof URL ? input.toString() : String(input);
      fetchedUrls.push(url);

      if (url.endsWith('/repos/acornops/skills')) {
        return jsonResponse({ default_branch: 'main' });
      }
      if (url.endsWith('/repos/acornops/skills/commits/main')) {
        return jsonResponse({ sha: 'commit-sha' });
      }
      if (url.endsWith('/repos/acornops/skills/git/trees/commit-sha?recursive=1')) {
        return jsonResponse({
          tree: [
            { path: '.gitignore', type: 'blob', mode: '100644', sha: 'ignore-sha' },
            { path: 'SKILL.md', type: 'blob', mode: '100644', sha: 'skill-sha' },
            { path: 'references/cnpg.md', type: 'blob', mode: '100644', sha: 'reference-sha' },
            { path: 'scripts/bootstrap.sh', type: 'blob', mode: '100755', sha: 'script-sha' }
          ]
        });
      }
      if (url.endsWith('/repos/acornops/skills/git/blobs/reference-sha')) {
        return jsonResponse({ encoding: 'base64', content: encodeContent('# CNPG\n') });
      }
      if (url.endsWith('/repos/acornops/skills/git/blobs/skill-sha')) {
        return jsonResponse({
          encoding: 'base64',
          content: encodeContent('---\nname: Troubleshooting CNPG\ndescription: Diagnose CNPG issues.\n---\n')
        });
      }

      return jsonResponse({ message: 'unexpected URL' }, 500);
    });

    const imported = await importTargetSkillFromGithub({
      repoUrl: 'https://github.com/acornops/skills'
    });

    assert.deepEqual(imported.files.map((file) => file.path), ['references/cnpg.md', 'SKILL.md']);
    assert.equal(imported.source.commitSha, 'commit-sha');
    assert.ok(!fetchedUrls.some((url) => url.endsWith('/git/blobs/ignore-sha')));
    assert.ok(!fetchedUrls.some((url) => url.endsWith('/git/blobs/script-sha')));
  });

  it('imports a skill when the GitHub URL points directly to a tree subpath', async () => {
    const fetchedUrls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof URL ? input.toString() : String(input);
      fetchedUrls.push(url);

      if (url.endsWith('/repos/openai/skills')) {
        return jsonResponse({ default_branch: 'main' });
      }
      if (url.endsWith('/repos/openai/skills/commits/main')) {
        return jsonResponse({ sha: 'commit-sha' });
      }
      if (url.endsWith('/repos/openai/skills/git/trees/commit-sha?recursive=1')) {
        return jsonResponse({
          tree: [
            { path: 'README.md', type: 'blob', mode: '100644', sha: 'readme-sha' },
            { path: 'skills/.curated/cli-creator/SKILL.md', type: 'blob', mode: '100644', sha: 'skill-sha' },
            {
              path: 'skills/.curated/cli-creator/references/agent-cli-patterns.md',
              type: 'blob',
              mode: '100644',
              sha: 'reference-sha'
            }
          ]
        });
      }
      if (url.endsWith('/repos/openai/skills/git/blobs/reference-sha')) {
        return jsonResponse({ encoding: 'base64', content: encodeContent('# CLI patterns\n') });
      }
      if (url.endsWith('/repos/openai/skills/git/blobs/skill-sha')) {
        return jsonResponse({
          encoding: 'base64',
          content: encodeContent('---\nname: cli-creator\ndescription: Build a CLI.\n---\n')
        });
      }

      return jsonResponse({ message: 'unexpected URL' }, 500);
    });

    const imported = await importTargetSkillFromGithub({
      repoUrl: 'https://github.com/openai/skills/tree/main/skills/.curated/cli-creator'
    });

    assert.deepEqual(imported.files.map((file) => file.path), ['references/agent-cli-patterns.md', 'SKILL.md']);
    assert.deepEqual(imported.source, {
      type: 'git_import',
      repoUrl: 'https://github.com/openai/skills',
      ref: 'main',
      subpath: 'skills/.curated/cli-creator',
      commitSha: 'commit-sha',
      syncStatus: 'current'
    });
    assert.ok(fetchedUrls.some((url) => url.endsWith('/repos/openai/skills/commits/main')));
  });

  it('authenticates GitHub API requests when an import token is configured', async () => {
    mutableConfig.GITHUB_IMPORT_TOKEN = 'github-token';
    const authorizationHeaders: Array<string | null> = [];
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      authorizationHeaders.push(new Headers(init?.headers).get('authorization'));
      const url = input instanceof URL ? input.toString() : String(input);

      if (url.endsWith('/repos/acornops/skills')) {
        return jsonResponse({ default_branch: 'main' });
      }
      if (url.endsWith('/repos/acornops/skills/commits/main')) {
        return jsonResponse({ sha: 'commit-sha' });
      }
      if (url.endsWith('/repos/acornops/skills/git/trees/commit-sha?recursive=1')) {
        return jsonResponse({
          tree: [{ path: 'SKILL.md', type: 'blob', mode: '100644', sha: 'skill-sha' }]
        });
      }
      if (url.endsWith('/repos/acornops/skills/git/blobs/skill-sha')) {
        return jsonResponse({
          encoding: 'base64',
          content: encodeContent('---\nname: Troubleshooting CNPG\ndescription: Diagnose CNPG issues.\n---\n')
        });
      }

      return jsonResponse({ message: 'unexpected URL' }, 500);
    });

    await importTargetSkillFromGithub({
      repoUrl: 'https://github.com/acornops/skills'
    });

    assert.deepEqual(authorizationHeaders, [
      'Bearer github-token',
      'Bearer github-token',
      'Bearer github-token',
      'Bearer github-token'
    ]);
  });

  it('falls back to a public archive import when GitHub API rate limits are exhausted', async () => {
    const fetchedUrls: string[] = [];
    const archive = createTarGz([
      { path: 'skills-main/.gitignore', content: 'node_modules\n' },
      { path: 'skills-main/SKILL.md', content: '---\nname: Troubleshooting CNPG\ndescription: Diagnose CNPG issues.\n---\n' },
      { path: 'skills-main/docs/cnpg.md', content: '# CNPG\n' },
      { path: 'skills-main/scripts/bootstrap.sh', content: '#!/usr/bin/env bash\n' }
    ]);
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof URL ? input.toString() : String(input);
      fetchedUrls.push(url);

      if (url.endsWith('/repos/acornops/skills')) {
        return jsonResponse({ message: 'API rate limit exceeded.' }, 403);
      }
      if (url === 'https://codeload.github.com/acornops/skills/tar.gz/main') {
        return binaryResponse(archive);
      }

      return jsonResponse({ message: 'unexpected URL' }, 500);
    });

    const imported = await importTargetSkillFromGithub({
      repoUrl: 'https://github.com/acornops/skills'
    });

    assert.deepEqual(imported.files.map((file) => file.path), ['docs/cnpg.md', 'SKILL.md']);
    assert.equal(imported.source.ref, 'main');
    assert.equal(imported.source.commitSha, undefined);
    assert.deepEqual(fetchedUrls, [
      'https://api.github.com/repos/acornops/skills',
      'https://codeload.github.com/acornops/skills/tar.gz/main'
    ]);
  });

  it('uses the ref and subpath from a GitHub tree URL during archive fallback', async () => {
    const fetchedUrls: string[] = [];
    const archive = createTarGz([
      { path: 'skills-main/SKILL.md', content: '---\nname: Root\ndescription: Root.\n---\n' },
      {
        path: 'skills-main/skills/.curated/cli-creator/SKILL.md',
        content: '---\nname: cli-creator\ndescription: Build a CLI.\n---\n'
      },
      { path: 'skills-main/skills/.curated/cli-creator/references/agent-cli-patterns.md', content: '# CLI patterns\n' }
    ]);
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof URL ? input.toString() : String(input);
      fetchedUrls.push(url);

      if (url.endsWith('/repos/openai/skills')) {
        return jsonResponse({ message: 'API rate limit exceeded.' }, 403);
      }
      if (url === 'https://codeload.github.com/openai/skills/tar.gz/main') {
        return binaryResponse(archive);
      }

      return jsonResponse({ message: 'unexpected URL' }, 500);
    });

    const imported = await importTargetSkillFromGithub({
      repoUrl: 'https://github.com/openai/skills/tree/main/skills/.curated/cli-creator'
    });

    assert.deepEqual(imported.files.map((file) => file.path), ['references/agent-cli-patterns.md', 'SKILL.md']);
    assert.deepEqual(imported.source, {
      type: 'git_import',
      repoUrl: 'https://github.com/openai/skills',
      ref: 'main',
      subpath: 'skills/.curated/cli-creator',
      commitSha: undefined,
      syncStatus: 'current'
    });
    assert.deepEqual(fetchedUrls, [
      'https://api.github.com/repos/openai/skills',
      'https://codeload.github.com/openai/skills/tar.gz/main'
    ]);
  });

  it('rejects GitHub tree URLs that conflict with explicit import fields', async () => {
    await assert.rejects(
      importTargetSkillFromGithub({
        repoUrl: 'https://github.com/openai/skills/tree/main/skills/.curated/cli-creator',
        subpath: 'skills/.curated/other-skill'
      }),
      (error) =>
        error instanceof GithubSkillImportError &&
        error.statusCode === 400 &&
        error.code === 'INVALID_REPO_URL' &&
        error.message.includes('already includes a subpath')
    );
  });

  it('rejects GitHub API imports that contain no Markdown skill files before persistence', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof URL ? input.toString() : String(input);

      if (url.endsWith('/repos/acornops/skills')) {
        return jsonResponse({ default_branch: 'main' });
      }
      if (url.endsWith('/repos/acornops/skills/commits/main')) {
        return jsonResponse({ sha: 'commit-sha' });
      }
      if (url.endsWith('/repos/acornops/skills/git/trees/commit-sha?recursive=1')) {
        return jsonResponse({
          tree: [{ path: 'scripts/bootstrap.sh', type: 'blob', mode: '100755', sha: 'script-sha' }]
        });
      }

      return jsonResponse({ message: 'unexpected URL' }, 500);
    });

    await assert.rejects(
      importTargetSkillFromGithub({
        repoUrl: 'https://github.com/acornops/skills'
      }),
      (error) =>
        error instanceof GithubSkillImportError &&
        error.statusCode === 400 &&
        error.code === 'INVALID_SKILL_BUNDLE'
    );
  });

  it('rejects GitHub API imports when SKILL.md is not at the selected root', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof URL ? input.toString() : String(input);

      if (url.endsWith('/repos/acornops/skills')) {
        return jsonResponse({ default_branch: 'main' });
      }
      if (url.endsWith('/repos/acornops/skills/commits/main')) {
        return jsonResponse({ sha: 'commit-sha' });
      }
      if (url.endsWith('/repos/acornops/skills/git/trees/commit-sha?recursive=1')) {
        return jsonResponse({
          tree: [
            { path: 'skills/cnpg/SKILL.md', type: 'blob', mode: '100644', sha: 'skill-sha' },
            { path: 'README.md', type: 'blob', mode: '100644', sha: 'readme-sha' }
          ]
        });
      }

      return jsonResponse({ message: 'unexpected URL' }, 500);
    });

    await assert.rejects(
      importTargetSkillFromGithub({
        repoUrl: 'https://github.com/acornops/skills'
      }),
      (error) =>
        error instanceof GithubSkillImportError &&
        error.statusCode === 400 &&
        error.code === 'INVALID_SKILL_BUNDLE' &&
        error.message.includes('Provide subpath')
    );
  });

  it('rejects archive fallback imports that contain no Markdown skill files before persistence', async () => {
    const archive = createTarGz([
      { path: 'skills-main/.gitignore', content: 'node_modules\n' },
      { path: 'skills-main/scripts/bootstrap.sh', content: '#!/usr/bin/env bash\n' }
    ]);
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof URL ? input.toString() : String(input);

      if (url.endsWith('/repos/acornops/skills')) {
        return jsonResponse({ message: 'API rate limit exceeded.' }, 403);
      }
      if (url === 'https://codeload.github.com/acornops/skills/tar.gz/main') {
        return binaryResponse(archive);
      }

      return jsonResponse({ message: 'unexpected URL' }, 500);
    });

    await assert.rejects(
      importTargetSkillFromGithub({
        repoUrl: 'https://github.com/acornops/skills'
      }),
      (error) =>
        error instanceof GithubSkillImportError &&
        error.statusCode === 400 &&
        error.code === 'INVALID_SKILL_BUNDLE'
    );
  });

  it('rejects archive fallback imports when SKILL.md is not at the selected root', async () => {
    const archive = createTarGz([
      { path: 'skills-main/README.md', content: '# Skills\n' },
      { path: 'skills-main/skills/cnpg/SKILL.md', content: '---\nname: CNPG\ndescription: CNPG.\n---\n' }
    ]);
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof URL ? input.toString() : String(input);

      if (url.endsWith('/repos/acornops/skills')) {
        return jsonResponse({ message: 'API rate limit exceeded.' }, 403);
      }
      if (url === 'https://codeload.github.com/acornops/skills/tar.gz/main') {
        return binaryResponse(archive);
      }

      return jsonResponse({ message: 'unexpected URL' }, 500);
    });

    await assert.rejects(
      importTargetSkillFromGithub({
        repoUrl: 'https://github.com/acornops/skills'
      }),
      (error) =>
        error instanceof GithubSkillImportError &&
        error.statusCode === 400 &&
        error.code === 'INVALID_SKILL_BUNDLE' &&
        error.message.includes('Provide subpath')
    );
  });
});
