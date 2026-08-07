import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readGatewayTextStream } from '../src/services/target-insights/gateway-text-stream.js';

const encoder = new TextEncoder();

describe('Target Insights gateway text stream', () => {
  it('returns text only after a terminal event', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"delta","text":"hel'));
        controller.enqueue(encoder.encode('lo"}\n{"type":"final","usage":{}}\n'));
        controller.close();
      }
    });

    assert.equal(await readGatewayTextStream(stream), 'hello');
  });

  it('cancels the response body when a terminal error is received', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          '{"type":"error","code":"PROVIDER_UNAVAILABLE","message":"Unavailable"}\n'
        ));
      },
      cancel() {
        cancelled = true;
      }
    });

    await assert.rejects(readGatewayTextStream(stream), /Unavailable/);
    assert.equal(cancelled, true);
  });
});
