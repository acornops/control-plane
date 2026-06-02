import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import {
  AgentMessageDecodeError,
  decodeAgentMessage,
  normalizeRawData
} from '../../src/agent/message-utils.js';

describe('agent message utils', () => {
  it('returns buffers unchanged', () => {
    const raw = Buffer.from('hello');
    assert.equal(normalizeRawData(raw), raw);
  });

  it('normalizes array buffers and chunk arrays', () => {
    const arrayBuffer = Uint8Array.from([104, 105]).buffer;
    assert.equal(normalizeRawData(arrayBuffer).toString('utf8'), 'hi');

    const chunked = normalizeRawData([Uint8Array.from([104, 101]), Uint8Array.from([121])]);
    assert.equal(chunked.toString('utf8'), 'hey');
  });

  it('decodes plain utf-8 messages', async () => {
    assert.equal(await decodeAgentMessage(Buffer.from('{"type":"heartbeat"}')), '{"type":"heartbeat"}');
  });

  it('decompresses gzipped messages before decoding', async () => {
    const compressed = gzipSync(Buffer.from('{"type":"snapshot"}', 'utf8'));
    assert.equal(await decodeAgentMessage(compressed, { allowCompression: true }), '{"type":"snapshot"}');
  });

  it('rejects compressed messages when compression is disabled', async () => {
    const compressed = gzipSync(Buffer.from('{"type":"snapshot"}', 'utf8'));
    await assert.rejects(
      decodeAgentMessage(compressed, { allowCompression: false }),
      AgentMessageDecodeError
    );
  });

  it('caps decompressed message output', async () => {
    const compressed = gzipSync(Buffer.alloc(4096, 'a'));
    await assert.rejects(
      decodeAgentMessage(compressed, {
        allowCompression: true,
        maxDecodedBytes: 1024
      }),
      AgentMessageDecodeError
    );
  });
});
