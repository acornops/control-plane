import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { persistToolResultArtifact, sanitizeArtifactResult } from '../../src/services/tool-result-artifacts.js';
import { repo } from '../../src/store/repository.js';

describe('tool result artifacts', () => {
  it('does not leak through malformed JSONL or legacy assignments spanning quotes', () => {
    for (const logs of [
      'log "unterminated\n{"password":"fixture-secret"}',
      'password=first"fixture-secret"',
      'password=\'first "fixture-secret" tail\'',
      '{"Bearer fixture-secret":"ready"}',
    ]) {
      const sanitized = sanitizeArtifactResult(logs) as string;
      assert.doesNotMatch(sanitized, /fixture-secret/);
      assert.match(sanitized, /<redacted/);
      assert.equal(sanitizeArtifactResult(sanitized), sanitized);
    }
  });

  it('preserves JSON formatting, scalar types and safe large logs while redacting quoted values', () => {
    for (const [input, expected] of [
      ['{ "api_key" : "fixture-secret", "count":3 }', '{ "api_key" : "<redacted>", "count":3 }'],
      ['{"password":"fixture-\\"secret","ok":true}', '{"password":"<redacted>","ok":true}'],
      ['{"secret":["fixture-secret"],"ok":null}', '{"secret":"<redacted>","ok":null}'],
      ['{"pwd":1234,"ok":false}', '{"pwd":"<redacted>","ok":false}'],
    ]) {
      assert.equal(sanitizeArtifactResult(input), expected);
      assert.equal(sanitizeArtifactResult(expected), expected);
    }
    const large = '{"level":"info","message":"request completed","status":200}\n'.repeat(12000);
    assert.equal(sanitizeArtifactResult(large), large);
  });

  it('redacts structured logs independently of the sending agent while preserving evidence', () => {
    const logs = 'time INFO {"password":"fixture-secret","status":"ready"}\n'
      + '{"pass\\u0077ord":{"parts":["fixture-secret"]},"count":3}\n';
    const sanitized = sanitizeArtifactResult({ logs }) as { logs: string };
    assert.equal(sanitized.logs, 'time INFO {"password":"<redacted>","status":"ready"}\n'
      + '{"pass\\u0077ord":"<redacted>","count":3}\n');
    assert.deepEqual(sanitizeArtifactResult(sanitized), sanitized);
  });

  it('sanitizes encoded and incomplete JSON strings and incomplete private keys', () => {
    for (const logs of [
      '{"password":"fixture-secret',
      '{"password":{\n"part":"fixture-secret"',
      '-----BEGIN PRIVATE KEY-----\nfixture-secret',
      JSON.stringify({ message: JSON.stringify({ password: 'fixture-secret', ok: true }) }),
    ]) {
      const sanitized = sanitizeArtifactResult(logs) as string;
      assert.doesNotMatch(sanitized, /fixture-secret/);
      assert.match(sanitized, /<redacted/);
      assert.equal(sanitizeArtifactResult(sanitized), sanitized);
    }
    assert.deepEqual(JSON.parse(sanitizeArtifactResult('{"message":"password=fixture-secret","ok":true}') as string),
      { message: 'password=<redacted>', ok: true });
  });

  it('stores only sanitized structured log bytes for JSON and plain-text artifacts', async () => {
    const original = repo.upsertToolResultArtifact;
    repo.upsertToolResultArtifact = async (input) => ({ ...input, createdAt: new Date().toISOString() });
    try {
      for (const contentType of ['application/json', 'text/plain']) {
        const logs = '{"api_key":"fixture-secret","status":"ready"}';
        const artifact = await persistToolResultArtifact({
          runId: 'run-1', workspaceId: 'workspace-1', callId: `logs-${contentType}`, toolName: 'get_resource_logs',
          result: contentType === 'text/plain' ? logs : { logs }, contentType,
        });
        const bytes = gunzipSync(artifact.payload);
        assert.doesNotMatch(bytes.toString('utf8'), /fixture-secret/);
        assert.match(bytes.toString('utf8'), /ready/);
        assert.equal(artifact.uncompressedBytes, bytes.length);
      }
    } finally {
      repo.upsertToolResultArtifact = original;
    }
  });

  it('redacts sensitive structured keys recursively', () => {
    assert.deepEqual(sanitizeArtifactResult({
      metadata: { name: 'api', token: 'secret-value' },
      nested: [{ password: 'plain', status: 'failed' }]
    }), {
      metadata: { name: 'api', token: '<redacted>' },
      nested: [{ password: '<redacted>', status: 'failed' }]
    });
  });

  it('redacts credentials embedded in log text', () => {
    const sanitized = sanitizeArtifactResult({
      logs: 'Authorization: Bearer abc.def.ghi Basic dXNlcjpwYXNz api_key=top-secret '
        + 'client_secret="client value" AWS_SECRET_ACCESS_KEY=aws-value AWS_ACCESS_KEY_ID=AKIAEXAMPLE '
        + 'postgresql://db-user:db-password@database.example/app https://user:hunter2@example.test/path'
    });
    const text = JSON.stringify(sanitized);
    assert.doesNotMatch(text, /abc\.def\.ghi|dXNlcjpwYXNz|top-secret|client value|aws-value|AKIAEXAMPLE|db-password|hunter2/);
    assert.match(text, /<redacted>/);
  });

  it('compresses, hashes, and bounds the stored result', async () => {
    const original = repo.upsertToolResultArtifact;
    let captured: Parameters<typeof repo.upsertToolResultArtifact>[0] | undefined;
    repo.upsertToolResultArtifact = async (input) => {
      captured = input;
      return { ...input, createdAt: new Date().toISOString() };
    };
    try {
      const artifact = await persistToolResultArtifact({
        runId: 'run-1', workspaceId: 'workspace-1', callId: 'call-1', toolName: 'get_resource',
        result: { metadata: { name: 'api', token: 'secret-value' } }
      });
      assert.equal(artifact.encoding, 'gzip');
      assert.equal(artifact.sha256.length, 64);
      assert.match(gunzipSync(captured!.payload).toString('utf8'), /<redacted>/);
      assert.doesNotMatch(gunzipSync(captured!.payload).toString('utf8'), /secret-value/);
    } finally {
      repo.upsertToolResultArtifact = original;
    }
  });

  it('stores plain-text artifacts as redacted text rather than JSON strings', async () => {
    const original = repo.upsertToolResultArtifact;
    let captured: Parameters<typeof repo.upsertToolResultArtifact>[0] | undefined;
    repo.upsertToolResultArtifact = async (input) => {
      captured = input;
      return { ...input, createdAt: new Date().toISOString() };
    };
    try {
      await persistToolResultArtifact({
        runId: 'run-1', workspaceId: 'workspace-1', callId: 'call-text', toolName: 'logs',
        result: 'Authorization: Bearer secret-token', contentType: 'text/plain'
      });
      assert.equal(gunzipSync(captured!.payload).toString('utf8'), 'Authorization: Bearer <redacted>');
    } finally {
      repo.upsertToolResultArtifact = original;
    }
  });

  it('rejects non-string plain-text artifacts', async () => {
    await assert.rejects(
      persistToolResultArtifact({
        runId: 'run-1', workspaceId: 'workspace-1', callId: 'call-text', toolName: 'logs',
        result: { message: 'not text' }, contentType: 'text/plain'
      }),
      /require a string result/
    );
  });

  it('allows an empty plain-text artifact', async () => {
    const original = repo.upsertToolResultArtifact;
    repo.upsertToolResultArtifact = async (input) => ({
      ...input, createdAt: new Date().toISOString()
    });
    try {
      const artifact = await persistToolResultArtifact({
        runId: 'run-1', workspaceId: 'workspace-1', callId: 'call-empty', toolName: 'logs',
        result: '', contentType: 'text/plain'
      });
      assert.equal(artifact.uncompressedBytes, 0);
    } finally {
      repo.upsertToolResultArtifact = original;
    }
  });

  it('rejects an oversized original result even when redaction would make it small', async () => {
    await assert.rejects(
      persistToolResultArtifact({
        runId: 'run-1', workspaceId: 'workspace-1', callId: 'call-large', toolName: 'get_resource',
        result: { token: 'x'.repeat(2 * 1024 * 1024) }
      }),
      /exceeds the configured uncompressed size limit/
    );
  });

  it('rejects reuse of a tool call ID for a different artifact result', async () => {
    const original = repo.upsertToolResultArtifact;
    repo.upsertToolResultArtifact = async (input) => ({
      ...input, sha256: '0'.repeat(64), createdAt: new Date().toISOString()
    });
    try {
      await assert.rejects(
        persistToolResultArtifact({
          runId: 'run-1', workspaceId: 'workspace-1', callId: 'call-1', toolName: 'get_resource',
          result: { metadata: { name: 'different' } }
        }),
        /call ID was already used/
      );
    } finally {
      repo.upsertToolResultArtifact = original;
    }
  });

  it('rejects reuse of a tool call ID with different artifact metadata', async () => {
    const original = repo.upsertToolResultArtifact;
    repo.upsertToolResultArtifact = async (input) => ({
      ...input, toolName: 'different_tool', createdAt: new Date().toISOString()
    });
    try {
      await assert.rejects(
        persistToolResultArtifact({
          runId: 'run-1', workspaceId: 'workspace-1', callId: 'call-1', toolName: 'get_resource',
          result: { metadata: { name: 'api' } }
        }),
        /call ID was already used/
      );
    } finally {
      repo.upsertToolResultArtifact = original;
    }
  });
});
