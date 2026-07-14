import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { persistToolResultArtifact, sanitizeArtifactResult } from '../../src/services/tool-result-artifacts.js';
import { repo } from '../../src/store/repository.js';

describe('tool result artifacts', () => {
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
