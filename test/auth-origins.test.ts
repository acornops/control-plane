import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../src/config.js';
import { allowedReturnToOrigins, corsOriginOption } from '../src/auth/origins.js';

const mutableConfig = config as typeof config & {
  CONTROL_PLANE_BASE_URL: string;
  CORS_ORIGIN: string;
};

const originalControlPlaneBaseUrl = config.CONTROL_PLANE_BASE_URL;
const originalCorsOrigin = config.CORS_ORIGIN;

afterEach(() => {
  mutableConfig.CONTROL_PLANE_BASE_URL = originalControlPlaneBaseUrl;
  mutableConfig.CORS_ORIGIN = originalCorsOrigin;
});

describe('auth origin helpers', () => {
  it('maps wildcard CORS configuration to the Express allow-all option', () => {
    mutableConfig.CORS_ORIGIN = '  * ';

    assert.equal(corsOriginOption(), true);
  });

  it('returns explicit allow-list origins when CORS is restricted', () => {
    mutableConfig.CORS_ORIGIN = 'https://app.example.com, https://ops.example.com';

    assert.deepEqual(corsOriginOption(), [
      'https://app.example.com',
      'https://ops.example.com'
    ]);
  });

  it('includes the control plane origin alongside configured return-to origins without duplicates', () => {
    mutableConfig.CONTROL_PLANE_BASE_URL = 'https://ops.example.com/control-plane';
    mutableConfig.CORS_ORIGIN = 'https://app.example.com, https://ops.example.com, https://app.example.com';

    assert.deepEqual(
      Array.from(allowedReturnToOrigins()).sort(),
      ['https://app.example.com', 'https://ops.example.com']
    );
  });

  it('still allows the control plane origin when wildcard CORS is configured', () => {
    mutableConfig.CONTROL_PLANE_BASE_URL = 'https://ops.example.com/control-plane';
    mutableConfig.CORS_ORIGIN = '*';

    assert.deepEqual(Array.from(allowedReturnToOrigins()), ['https://ops.example.com']);
  });
});
