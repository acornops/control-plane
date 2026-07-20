import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PromptResourceProviderError } from '../../src/services/prompt-resources/errors.js';
import { promptResourceRegistry } from '../../src/services/prompt-resources/index.js';
import type {
  PromptResolutionContext,
  PromptResourceAuthorization,
  PromptResourceCandidate,
  PromptResourceProvider
} from '../../src/types/prompt-resources.js';

const context: PromptResolutionContext = {
  workspaceId: 'workspace-1',
  actorUserId: 'user-1',
  workflowId: 'workflow-1',
  workflowSessionId: 'session-1',
  initiatingMessageId: 'message-1',
  mode: 'launch'
};

const providers: PromptResourceProvider[] = promptResourceRegistry.descriptors()
  .map((descriptor) => promptResourceRegistry.provider(descriptor.type))
  .filter((provider): provider is PromptResourceProvider => Boolean(provider));

describe('prompt resource provider contract', () => {
  it('publishes valid, unique, bounded descriptors for every registered provider', () => {
    const descriptors = providers.map((provider) => provider.descriptor());
    assert.equal(new Set(descriptors.map((descriptor) => descriptor.type)).size, descriptors.length);
    for (const descriptor of descriptors) {
      assert.match(descriptor.type, /^[a-z][a-z0-9_-]{0,63}$/);
      assert(descriptor.displayName.length > 0);
      assert(descriptor.provider.length > 0);
      assert(descriptor.providerVersion.length > 0);
      assert(descriptor.minimum >= 0);
      assert(descriptor.maximum >= descriptor.minimum);
      assert(descriptor.maximum <= 64);
    }
  });

  it('binds provider-owned identity without changing the candidate resource', async () => {
    for (const provider of providers.filter((item) => item.descriptor().availability === 'available')) {
      const descriptor = provider.descriptor();
      const candidate: PromptResourceCandidate = {
        type: descriptor.type,
        id: `${descriptor.type}-1`,
        label: `${descriptor.displayName} one`,
        provider: descriptor.provider,
        availability: 'available'
      };
      const authorization: PromptResourceAuthorization = {
        operations: ['read'],
        contextMode: descriptor.type === 'target'
          ? 'routing_only'
          : descriptor.implicit ? 'inline' : 'tool',
        ...(descriptor.type === 'target'
          ? { providerData: { targetType: 'kubernetes' } }
          : descriptor.implicit ? { providerData: { throughMessageId: 'message-1' } } : {})
      };
      const bound = await provider.bind(candidate, authorization, context);
      assert.equal(bound.type, descriptor.type);
      assert.equal(bound.resourceId, candidate.id);
      assert.equal(bound.provider, descriptor.provider);
      assert.equal(bound.providerVersion, descriptor.providerVersion);
      assert.equal(bound.workspaceId, context.workspaceId);
      assert.equal(bound.labelSnapshot, candidate.label);
      assert.deepEqual(bound.operations, authorization.operations);
      assert.equal(bound.source, descriptor.implicit ? 'implicit' : 'explicit');
    }
  });

  it('keeps unavailable providers explicit and fail-closed', async () => {
    const provider = promptResourceRegistry.provider('repository')!;
    const descriptor = provider.descriptor();
    assert.equal(descriptor.availability, 'unavailable');
    assert(descriptor.unavailableReason);
    await assert.rejects(
      provider.resolve({ type: descriptor.type, label: 'repo', start: 0, end: 17, state: 'concrete' }, context),
      (error: unknown) => error instanceof PromptResourceProviderError
        && error.code === 'PROMPT_REFERENCE_UNAVAILABLE'
    );
  });

  it('projects an exact target route only from target provider data', async () => {
    const provider = promptResourceRegistry.provider('target')!;
    const descriptor = provider.descriptor();
    const bound = await provider.bind({
      type: descriptor.type,
      id: 'target-1',
      label: 'Production',
      provider: descriptor.provider,
      availability: 'available'
    }, {
      operations: ['read'],
      contextMode: 'routing_only',
      providerData: { targetType: 'kubernetes' }
    }, context);
    assert.deepEqual(provider.projectRuntime({ ...bound, bindingId: 'prb_target' }), {
      targetRoute: { id: 'target-1', targetType: 'kubernetes' }
    });
  });
});
