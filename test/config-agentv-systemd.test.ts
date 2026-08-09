import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAppConfig } from '../src/config.js';
import { fieldErrors, productionEnv } from './helpers/config-fixtures.js';

describe('AgentV systemd release configuration', () => {
  it('rejects release URLs that cannot be represented safely by the installer', () => {
    for (const releaseBaseUrl of ["https://artifacts.example.com/'agentv'", 'https://artifacts.example.com/\\agentv']) {
      assert.throws(
        () => parseAppConfig(productionEnv({ AGENTV_SYSTEMD_RELEASE_BASE_URL: releaseBaseUrl })),
        (error) => Boolean(fieldErrors(error).AGENTV_SYSTEMD_RELEASE_BASE_URL?.length)
      );
    }
  });

  it('rejects public platform URLs that cannot be represented safely by the bootstrap', () => {
    for (const controlPlaneBaseUrl of [
      'https://user@api.example.com',
      'https://api.example.com/acornops?tenant=one',
      'https://api.example.com/acornops#fragment',
      "https://api.example.com/'acornops'",
      'https://api.example.com/\\acornops'
    ]) {
      assert.throws(
        () => parseAppConfig(productionEnv({ CONTROL_PLANE_BASE_URL: controlPlaneBaseUrl })),
        (error) => Boolean(fieldErrors(error).CONTROL_PLANE_BASE_URL?.length)
      );
    }
  });
});
