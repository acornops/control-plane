import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { resolvePlatformSettingsDeploymentPolicy } from '../src/config-platform-settings.js';

describe('platform settings deployment policy', () => {
  it('uses conservative discovery defaults and the existing password signup default', () => {
    const policy = resolvePlatformSettingsDeploymentPolicy(undefined, false);

    assert.deepEqual(policy.memberDiscovery, {
      allowedModes: ['disabled', 'exact_email'],
      defaultMode: 'exact_email'
    });
    assert.deepEqual(policy.aiPolicy, { runtimeEditable: true });
    assert.deepEqual(policy.passwordSignup, {
      allowedValues: [false, true],
      defaultValue: false
    });
  });

  it('accepts an explicit trusted directory mode and fixed password policy', () => {
    const policy = resolvePlatformSettingsDeploymentPolicy(JSON.stringify({
      memberDiscovery: {
        allowedModes: ['disabled', 'exact_email', 'directory'],
        defaultMode: 'directory'
      },
      aiPolicy: { runtimeEditable: false },
      passwordSignup: {
        allowedValues: [false],
        defaultValue: false
      }
    }), true);

    assert.equal(policy.memberDiscovery.defaultMode, 'directory');
    assert.equal(policy.aiPolicy.runtimeEditable, false);
    assert.deepEqual(policy.passwordSignup.allowedValues, [false]);
  });

  it('rejects malformed JSON and defaults outside their deployment ceiling', () => {
    assert.throws(
      () => resolvePlatformSettingsDeploymentPolicy('{', false),
      /must be valid JSON/
    );
    assert.throws(
      () => resolvePlatformSettingsDeploymentPolicy(JSON.stringify({
        memberDiscovery: {
          allowedModes: ['disabled'],
          defaultMode: 'directory'
        }
      }), false),
      /defaultMode must be included/
    );
    assert.throws(
      () => resolvePlatformSettingsDeploymentPolicy(JSON.stringify({
        passwordSignup: {
          allowedValues: [false],
          defaultValue: true
        }
      }), false),
      /defaultValue must be included/
    );
    assert.throws(
      () => resolvePlatformSettingsDeploymentPolicy(JSON.stringify({
        unexpected: true
      }), false),
      (error) => error instanceof ZodError
    );
  });
});
