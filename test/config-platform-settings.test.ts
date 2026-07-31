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
    assert.deepEqual(policy.kubernetesRbacAdditions, {
      runtimeEditable: true,
      profiles: []
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
      },
      kubernetesRbacAdditions: {
        runtimeEditable: false,
        profiles: [{
          key: 'cnpg',
          name: 'CNPG',
          resources: [{
            apiGroup: 'postgresql.cnpg.io',
            apiVersion: 'v1',
            resource: 'clusters',
            kind: 'Cluster',
            scope: 'namespaced',
            verbs: ['list', 'patch']
          }]
        }]
      }
    }), ['password', 'oidc']);

    assert.equal(policy.memberDiscovery.defaultMode, 'directory');
    assert.equal(policy.aiPolicy.runtimeEditable, false);
    assert.deepEqual(policy.userSignInMethods.allowedMethods, ['oidc']);
    assert.equal(policy.kubernetesRbacAdditions.runtimeEditable, false);
    assert.deepEqual(policy.kubernetesRbacAdditions.profiles.map((profile) => profile.key), ['cnpg']);
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
