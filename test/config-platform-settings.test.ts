import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { resolvePlatformSettingsDeploymentPolicy } from '../src/config-platform-settings.js';

describe('platform settings deployment policy', () => {
  it('uses conservative discovery defaults and all deployment-configured sign-in methods', () => {
    const policy = resolvePlatformSettingsDeploymentPolicy(undefined, ['password', 'oidc']);

    assert.deepEqual(policy.memberDiscovery, {
      allowedModes: ['disabled', 'exact_email'],
      defaultMode: 'exact_email'
    });
    assert.deepEqual(policy.aiPolicy, { runtimeEditable: true });
    assert.deepEqual(policy.userSignInMethods, {
      allowedMethods: ['password', 'oidc'],
      defaultMethods: ['password', 'oidc']
    });
  });

  it('accepts an explicit trusted directory mode and constrained sign-in methods', () => {
    const policy = resolvePlatformSettingsDeploymentPolicy(JSON.stringify({
      memberDiscovery: {
        allowedModes: ['disabled', 'exact_email', 'directory'],
        defaultMode: 'directory'
      },
      aiPolicy: { runtimeEditable: false },
      userSignInMethods: {
        allowedMethods: ['oidc'],
        defaultMethods: ['oidc']
      }
    }), ['password', 'oidc']);

    assert.equal(policy.memberDiscovery.defaultMode, 'directory');
    assert.equal(policy.aiPolicy.runtimeEditable, false);
    assert.deepEqual(policy.userSignInMethods.allowedMethods, ['oidc']);
  });

  it('rejects malformed JSON and defaults outside their deployment ceiling', () => {
    assert.throws(
      () => resolvePlatformSettingsDeploymentPolicy('{', ['password']),
      /must be valid JSON/
    );
    assert.throws(
      () => resolvePlatformSettingsDeploymentPolicy(JSON.stringify({
        memberDiscovery: {
          allowedModes: ['disabled'],
          defaultMode: 'directory'
        }
      }), ['password']),
      /defaultMode must be included/
    );
    assert.throws(
      () => resolvePlatformSettingsDeploymentPolicy(JSON.stringify({
        userSignInMethods: {
          allowedMethods: ['password'],
          defaultMethods: ['oidc']
        }
      }), ['password', 'oidc']),
      /defaultMethods must be included/
    );
    assert.throws(
      () => resolvePlatformSettingsDeploymentPolicy(JSON.stringify({
        unexpected: true
      }), ['password']),
      (error) => error instanceof ZodError
    );
  });
});
