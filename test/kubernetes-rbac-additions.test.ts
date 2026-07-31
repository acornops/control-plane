import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  kubernetesRbacAdditionsHash,
  kubernetesRbacAdditionsOverrideSchema,
  kubernetesRbacAdditionsValueSchema,
  mergeKubernetesRbacAdditions,
  selectKubernetesRbacAdditions
} from '../src/services/kubernetes-rbac-additions.js';

const cnpg = {
  key: 'cnpg', name: 'CNPG', description: 'CloudNativePG clusters',
  resources: [{
    apiGroup: 'postgresql.cnpg.io', apiVersion: 'v1', resource: 'clusters', kind: 'Cluster',
    scope: 'namespaced' as const, verbs: ['list', 'patch'] as const
  }]
};

describe('Kubernetes RBAC additions', () => {
  it('resolves selections in requested order and rejects stale keys', () => {
    assert.deepEqual(selectKubernetesRbacAdditions([cnpg], ['cnpg']), [cnpg]);
    assert.throws(() => selectKubernetesRbacAdditions([cnpg], ['missing']), /Unknown Kubernetes RBAC addition/);
  });

  it('accepts the supported verbs, requires list for patch, and rejects unsupported verbs', () => {
    const patchOnly = structuredClone(cnpg) as any;
    patchOnly.resources[0].verbs = ['patch'];
    assert.equal(kubernetesRbacAdditionsValueSchema.safeParse({ additions: [patchOnly] }).success, false);
    patchOnly.resources[0].verbs = ['get', 'list', 'watch', 'create', 'patch', 'delete'];
    assert.equal(kubernetesRbacAdditionsValueSchema.safeParse({ additions: [patchOnly] }).success, true);
    patchOnly.resources[0].verbs = ['list', 'update'];
    assert.equal(kubernetesRbacAdditionsValueSchema.safeParse({ additions: [patchOnly] }).success, false);
    patchOnly.resources[0].verbs = ['list'];
    patchOnly.resources[0].resource = '*';
    assert.equal(kubernetesRbacAdditionsValueSchema.safeParse({ additions: [patchOnly] }).success, false);
  });

  it('requires resource plurals to be unique within a profile', () => {
    const ambiguous = structuredClone(cnpg) as any;
    ambiguous.resources.push({
      ...ambiguous.resources[0],
      apiGroup: 'backups.example.io',
      kind: 'BackupCluster'
    });

    assert.equal(kubernetesRbacAdditionsValueSchema.safeParse({ additions: [ambiguous] }).success, false);
  });

  it('creates a stable content hash for the immutable snapshot', () => {
    assert.equal(kubernetesRbacAdditionsHash([cnpg]), kubernetesRbacAdditionsHash(structuredClone([cnpg])));
    assert.notEqual(kubernetesRbacAdditionsHash([cnpg]), kubernetesRbacAdditionsHash([]));
  });

  it('replaces, extends, and disables deployment profiles by stable key', () => {
    const replacement = { ...cnpg, name: 'CNPG with backups' };
    const mongodb = {
      ...cnpg,
      key: 'mongodb',
      name: 'MongoDB',
      resources: [{ ...cnpg.resources[0], apiGroup: 'mongodbcommunity.mongodb.com', resource: 'mongodbcommunity', kind: 'MongoDBCommunity', verbs: ['list'] as const }]
    };
    assert.deepEqual(
      mergeKubernetesRbacAdditions(
        { additions: [cnpg] },
        { upserts: [replacement, mongodb], disabledKeys: [] }
      ).additions,
      [replacement, mongodb]
    );
    assert.deepEqual(
      mergeKubernetesRbacAdditions(
        { additions: [cnpg] },
        { upserts: [mongodb], disabledKeys: ['cnpg'] }
      ).additions,
      [mongodb]
    );
  });

  it('rejects an overlay that upserts and disables the same profile', () => {
    assert.equal(kubernetesRbacAdditionsOverrideSchema.safeParse({
      upserts: [cnpg], disabledKeys: ['cnpg']
    }).success, false);
  });
});
