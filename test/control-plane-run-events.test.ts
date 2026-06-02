import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  handleRunEventMessageForTests,
  publishRunEvents,
  registerRunEventHandler
} from '../src/services/control-plane-coordination.js';
import {
  PublishedMessage,
  installRedisStore,
  setupControlPlaneCoordinationTest,
  teardownControlPlaneCoordinationTest,
  testRunEvent
} from './helpers/agent-gateway-fixtures.js';

beforeEach(setupControlPlaneCoordinationTest);
afterEach(teardownControlPlaneCoordinationTest);

describe('control-plane run event fanout', () => {
  it('publishes run events with an origin instance for cross-pod SSE fanout', async () => {
    const published: PublishedMessage[] = [];
    installRedisStore(new Map<string, string>(), published);
    const event = testRunEvent();

    await publishRunEvents('run-1', [event]);

    assert.equal(published.length, 1);
    assert.equal(published[0]!.channel, 'cp:run-events');
    assert.deepEqual(JSON.parse(published[0]!.message), {
      originInstanceId: 'cp-test-a',
      runId: 'run-1',
      events: [event]
    });
  });

  it('delivers cross-pod run events and ignores same-origin fanout messages', () => {
    let delivered: unknown;
    registerRunEventHandler((envelope) => {
      delivered = envelope;
    });
    const event = testRunEvent();

    handleRunEventMessageForTests(JSON.stringify({
      originInstanceId: 'cp-test-a',
      runId: 'run-1',
      events: [event]
    }));
    assert.equal(delivered, undefined);

    handleRunEventMessageForTests(JSON.stringify({
      originInstanceId: 'cp-test-b',
      runId: 'run-1',
      events: [event]
    }));
    assert.deepEqual(delivered, {
      originInstanceId: 'cp-test-b',
      runId: 'run-1',
      events: [event]
    });
  });
});
