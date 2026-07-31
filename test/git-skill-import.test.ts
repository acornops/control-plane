import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GitSkillImportError,
  resolveGitSkill
} from '../src/services/git-skill-import.js';
import type { GitImportHost } from '../src/config-git-imports.js';

const sha = '0123456789abcdef0123456789abcdef01234567';

function jsonResponse(value: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

test('resolves a GitHub folder URL to a pinned Markdown snapshot', async () => {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    if (url === 'https://api.github.com/repos/openai/skills') {
      return jsonResponse({ default_branch: 'main' });
    }
    if (url.endsWith('/commits/main')) return jsonResponse({ sha });
    if (url.endsWith(`/git/trees/${sha}`)) {
      return jsonResponse({ tree: [{ path: 'skills', type: 'tree', sha: 'skills-tree' }] });
    }
    if (url.endsWith('/git/trees/skills-tree')) {
      return jsonResponse({ tree: [{ path: 'example', type: 'tree', sha: 'example-tree' }] });
    }
    if (url.endsWith('/git/trees/example-tree?recursive=1')) {
      return jsonResponse({
        tree: [
          { path: 'SKILL.md', type: 'blob', sha: 'skill' },
          { path: 'reference.md', type: 'blob', sha: 'reference' },
          { path: 'script.sh', type: 'blob', sha: 'script' }
        ]
      });
    }
    if (url.endsWith('/git/blobs/skill')) {
      return jsonResponse({
        encoding: 'base64',
        content: Buffer.from('---\nname: Example\ndescription: Test\n---\n').toString('base64')
      });
    }
    if (url.endsWith('/git/blobs/reference')) {
      return jsonResponse({
        encoding: 'base64',
        content: Buffer.from('# Reference\n').toString('base64')
      });
    }
    return new Response(null, { status: 404 });
  };

  const resolved = await resolveGitSkill({
    repoUrl: 'https://github.com/openai/skills/tree/main/skills/example'
  }, fetchImpl as typeof fetch);

  assert.deepEqual(resolved.source, {
    provider: 'github',
    repoUrl: 'https://github.com/openai/skills',
    ref: 'main',
    subpath: 'skills/example',
    commitSha: sha
  });
  assert.deepEqual(resolved.files.map((file) => file.path), ['SKILL.md', 'reference.md']);
  assert.equal(requested.some((url) => url.includes('script.sh')), false);
  assert.equal(requested.includes(`https://api.github.com/repos/openai/skills/git/trees/${sha}?recursive=1`), false);
  assert.equal(requested.some((url) => url.endsWith('/git/trees/example-tree?recursive=1')), true);
});

test('accepts a GitHub SKILL.md URL and imports its containing folder', async () => {
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/openai/skills') return jsonResponse({ default_branch: 'main' });
    if (url.endsWith('/commits/main')) return jsonResponse({ sha });
    if (url.endsWith(`/git/trees/${sha}`)) {
      return jsonResponse({ tree: [{ path: 'skills', type: 'tree', sha: 'skills-tree' }] });
    }
    if (url.endsWith('/git/trees/skills-tree')) {
      return jsonResponse({ tree: [{ path: 'example', type: 'tree', sha: 'example-tree' }] });
    }
    if (url.endsWith('/git/trees/example-tree?recursive=1')) {
      return jsonResponse({ tree: [{ path: 'SKILL.md', type: 'blob', sha: 'skill' }] });
    }
    if (url.endsWith('/git/blobs/skill')) {
      return jsonResponse({
        encoding: 'base64',
        content: Buffer.from('---\nname: Example\ndescription: Test\n---\n').toString('base64')
      });
    }
    return new Response(null, { status: 404 });
  };

  const resolved = await resolveGitSkill({
    repoUrl: 'https://github.com/openai/skills/blob/main/skills/example/SKILL.md'
  }, fetchImpl as typeof fetch);

  assert.equal(resolved.source.subpath, 'skills/example');
  assert.deepEqual(resolved.files.map((file) => file.path), ['SKILL.md']);
});

test('resolves slash-containing refs from copied GitHub folder URLs', async () => {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    if (url === 'https://api.github.com/repos/acornops/skills') {
      return jsonResponse({ default_branch: 'main' });
    }
    if (url.endsWith('/commits/feature')) return new Response(null, { status: 404 });
    if (url.endsWith('/commits/feature%2Fincident')) return jsonResponse({ sha });
    if (url.endsWith(`/git/trees/${sha}`)) {
      return jsonResponse({ tree: [{ path: 'skills', type: 'tree', sha: 'skills-tree' }] });
    }
    if (url.endsWith('/git/trees/skills-tree')) {
      return jsonResponse({ tree: [{ path: 'example', type: 'tree', sha: 'example-tree' }] });
    }
    if (url.endsWith('/git/trees/example-tree?recursive=1')) {
      return jsonResponse({
        tree: [{ path: 'SKILL.md', type: 'blob', sha: 'skill' }]
      });
    }
    if (url.endsWith('/git/blobs/skill')) {
      return jsonResponse({
        encoding: 'base64',
        content: Buffer.from('---\nname: Example\ndescription: Test\n---\n').toString('base64')
      });
    }
    return new Response(null, { status: 404 });
  };

  const resolved = await resolveGitSkill({
    repoUrl: 'https://github.com/acornops/skills/tree/feature/incident/skills/example'
  }, fetchImpl as typeof fetch);

  assert.equal(resolved.source.ref, 'feature/incident');
  assert.equal(resolved.source.subpath, 'skills/example');
  assert.equal(requested.some((url) => url.endsWith('/commits/feature%2Fincident')), true);
});

test('resolves a path-prefixed custom GitLab host to a pinned snapshot', async () => {
  const host: GitImportHost = {
    provider: 'gitlab',
    webBaseUrl: 'https://git.example.com/platform',
    apiBaseUrl: 'https://git.example.com/platform/api/v4'
  };
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    if (url === 'https://git.example.com/platform/api/v4/projects/acornops%2Fskills') {
      return jsonResponse({ default_branch: 'main' });
    }
    if (url.endsWith('/repository/commits/main')) return jsonResponse({ id: sha });
    if (url.includes('/repository/tree?')) {
      return jsonResponse([
        { path: 'incident/SKILL.md', type: 'blob', id: 'skill' },
        { path: 'incident/reference.md', type: 'blob', id: 'reference' }
      ]);
    }
    if (url.endsWith('/repository/blobs/skill/raw')) {
      return new Response('---\nname: Incident\ndescription: Test\n---\n');
    }
    if (url.endsWith('/repository/blobs/reference/raw')) {
      return new Response('# Reference\n');
    }
    return new Response(null, { status: 404 });
  };

  const resolved = await resolveGitSkill({
    repoUrl: 'https://git.example.com/platform/acornops/skills/-/tree/main/incident'
  }, fetchImpl as typeof fetch, [host]);

  assert.deepEqual(resolved.source, {
    provider: 'gitlab',
    repoUrl: 'https://git.example.com/platform/acornops/skills',
    ref: 'main',
    subpath: 'incident',
    commitSha: sha
  });
  assert.deepEqual(resolved.files.map((file) => file.path), ['SKILL.md', 'reference.md']);
  assert.equal(requested.some((url) => url.includes('path=incident')), true);
});

test('bounds provider responses before JSON parsing', async () => {
  await assert.rejects(
    resolveGitSkill(
      { repoUrl: 'https://github.com/acornops/skills' },
      (async () => new Response('{}', {
        status: 200,
        headers: { 'content-length': String(64 * 1024 + 1) }
      })) as typeof fetch
    ),
    (error: unknown) =>
      error instanceof GitSkillImportError
      && error.code === 'GIT_PROVIDER_FAILED'
      && error.status === 502
  );
});

test('classifies GitHub 403 rate limits as retryable rate limits', async () => {
  await assert.rejects(
    resolveGitSkill(
      { repoUrl: 'https://github.com/acornops/skills' },
      (async () => new Response(null, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' }
      })) as typeof fetch
    ),
    (error: unknown) =>
      error instanceof GitSkillImportError
      && error.code === 'GIT_RATE_LIMITED'
      && error.status === 429
  );
});

test('rejects non-UTF-8 Markdown content from a Git provider', async () => {
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === 'https://gitlab.com/api/v4/projects/acornops%2Fskills') {
      return jsonResponse({ default_branch: 'main' });
    }
    if (url.endsWith('/repository/commits/main')) return jsonResponse({ id: sha });
    if (url.includes('/repository/tree?')) {
      return jsonResponse([{ path: 'SKILL.md', type: 'blob', id: 'skill' }]);
    }
    if (url.endsWith('/repository/blobs/skill/raw')) {
      return new Response(Uint8Array.from([0xff, 0xfe]));
    }
    return new Response(null, { status: 404 });
  };

  await assert.rejects(
    resolveGitSkill(
      { repoUrl: 'https://gitlab.com/acornops/skills' },
      fetchImpl as typeof fetch
    ),
    (error: unknown) =>
      error instanceof GitSkillImportError
      && error.code === 'GIT_PROVIDER_FAILED'
      && error.status === 502
  );
});

test('rejects repositories outside configured Git hosts before fetching', async () => {
  let fetched = false;
  await assert.rejects(
    resolveGitSkill(
      { repoUrl: 'https://bitbucket.org/acornops/skills' },
      (async () => {
        fetched = true;
        return new Response(null, { status: 500 });
      }) as typeof fetch
    ),
    (error: unknown) =>
      error instanceof GitSkillImportError &&
      error.code === 'UNSUPPORTED_GIT_HOST'
  );
  assert.equal(fetched, false);
});

test('rejects credentials, query parameters, and fragments before fetching', async () => {
  for (const repoUrl of [
    'https://user@example.com/acornops/skills',
    'https://github.com/acornops/skills?token=secret',
    'https://github.com/acornops/skills#readme'
  ]) {
    let fetched = false;
    await assert.rejects(
      resolveGitSkill(
        { repoUrl },
        (async () => {
          fetched = true;
          return new Response(null, { status: 500 });
        }) as typeof fetch
      ),
      (error: unknown) =>
        error instanceof GitSkillImportError
        && error.code === 'INVALID_REPO_URL'
    );
    assert.equal(fetched, false);
  }
});
