import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isConfiguredGitImportSource,
  matchGitImportHost,
  parseGitImportHosts
} from '../src/config-git-imports.js';

test('parses and longest-prefix matches configured Git import hosts', () => {
  const hosts = parseGitImportHosts(JSON.stringify([
    {
      provider: 'gitlab',
      webBaseUrl: 'https://git.example.com',
      apiBaseUrl: 'https://git.example.com/api/v4'
    },
    {
      provider: 'gitlab',
      webBaseUrl: 'https://git.example.com/platform',
      apiBaseUrl: 'https://git.example.com/platform/api/v4'
    }
  ]));

  assert.equal(
    matchGitImportHost('https://git.example.com/platform/acornops/skills/-/tree/main/ops', hosts)?.webBaseUrl,
    'https://git.example.com/platform'
  );
  assert.equal(
    matchGitImportHost('https://git.example.com/platform-other/acornops/skills', hosts)?.webBaseUrl,
    'https://git.example.com'
  );
  assert.equal(
    isConfiguredGitImportSource('gitlab', 'https://git.example.com/platform/acornops/skills', hosts),
    true
  );
  assert.equal(
    isConfiguredGitImportSource('github', 'https://git.example.com/platform/acornops/skills', hosts),
    false
  );
});

test('rejects unsafe or provider-incompatible Git import host configuration', () => {
  assert.throws(
    () => parseGitImportHosts('[{"provider":"github","webBaseUrl":"http://git.example.com","apiBaseUrl":"https://git.example.com/api/v3"}]'),
    /webBaseUrl must use HTTPS/
  );
  assert.throws(
    () => parseGitImportHosts('[{"provider":"gitlab","webBaseUrl":"https://git.example.com","apiBaseUrl":"https://git.example.com/api/v3"}]'),
    /apiBaseUrl must end with \/api\/v4/
  );
  assert.throws(
    () => parseGitImportHosts('[{"provider":"github","webBaseUrl":"https://git.example.com","apiBaseUrl":"https://git.example.com/api/v3"},{"provider":"github","webBaseUrl":"https://git.example.com/","apiBaseUrl":"https://git.example.com/api/v3"}]'),
    /duplicate webBaseUrl/
  );
});
