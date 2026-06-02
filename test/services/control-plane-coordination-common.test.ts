import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../../src/config.js';
import {
  controlPlaneInstanceId,
  distributedRoutingEnabled,
  parseJsonObject
} from '../../src/services/control-plane-coordination/common.js';

const mutableConfig = config as typeof config & {
  CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED: boolean;
  CONTROL_PLANE_INSTANCE_ID: string;
};

const originalDistributedRoutingEnabled = config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED;
const originalControlPlaneInstanceId = config.CONTROL_PLANE_INSTANCE_ID;

afterEach(() => {
  mutableConfig.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = originalDistributedRoutingEnabled;
  mutableConfig.CONTROL_PLANE_INSTANCE_ID = originalControlPlaneInstanceId;
});

describe('control-plane coordination common helpers', () => {
  it('reads distributed routing and instance id from config', () => {
    mutableConfig.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = true;
    mutableConfig.CONTROL_PLANE_INSTANCE_ID = 'cp-instance-2';

    assert.equal(distributedRoutingEnabled(), true);
    assert.equal(controlPlaneInstanceId(), 'cp-instance-2');
  });

  it('parses only JSON objects', () => {
    assert.deepEqual(parseJsonObject('{"hello":"world","count":1}'), {
      hello: 'world',
      count: 1
    });
    assert.equal(parseJsonObject('"string"'), undefined);
    assert.equal(parseJsonObject('["array"]'), undefined);
    assert.equal(parseJsonObject('null'), undefined);
    assert.equal(parseJsonObject('{not-json}'), undefined);
  });
});
