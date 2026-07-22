import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  PromptReferenceTypeDescriptor,
  PromptResolutionContext,
  PromptResourceAuthorization,
  PromptResourceBinding,
  PromptResourceCandidate,
  PromptResourceProvider,
  PromptResourceSuggestionContext,
  PromptReferenceToken
} from '../../src/types/prompt-resources.js';
import { digestBindings, PromptResourceProviderError, PromptResourceRegistry } from '../../src/services/prompt-resources/index.js';

class ContractProvider implements PromptResourceProvider {
  constructor(
    private readonly type: string,
    private readonly behavior: 'ok' | 'missing' = 'ok',
    private readonly maximum = 4
  ) {}

  descriptor(): PromptReferenceTypeDescriptor {
    return {
      type: this.type,
      displayName: this.type,
      description: 'Test provider',
      icon: 'test',
      placeholderLabel: 'Label',
      availability: 'available',
      minimum: 0,
      maximum: this.maximum,
      allowPinnedReferences: true,
      provider: `test.${this.type}`,
      providerVersion: '1'
    };
  }

  async suggest(context: PromptResourceSuggestionContext): Promise<PromptResourceCandidate[]> {
    return [{ type: this.type, id: context.query, label: context.query, provider: `test.${this.type}`, availability: 'available' }];
  }

  async resolve(token: PromptReferenceToken, _context: PromptResolutionContext): Promise<PromptResourceCandidate> {
    if (this.behavior === 'missing') throw new PromptResourceProviderError('PROMPT_REFERENCE_NOT_FOUND', `${this.type} was not found.`);
    return { type: this.type, id: token.label.toLocaleLowerCase(), label: token.label, provider: `test.${this.type}`, availability: 'available' };
  }

  async authorize(_candidate: PromptResourceCandidate, _context: PromptResolutionContext): Promise<PromptResourceAuthorization> {
    return { operations: ['read'], contextMode: 'tool' };
  }

  async bind(candidate: PromptResourceCandidate, authorization: PromptResourceAuthorization, context: PromptResolutionContext): Promise<Omit<PromptResourceBinding, 'bindingId'>> {
    return {
      type: this.type,
      resourceId: candidate.id,
      provider: `test.${this.type}`,
      providerVersion: '1',
      workspaceId: context.workspaceId,
      labelSnapshot: candidate.label,
      source: context.source || 'explicit',
      operations: authorization.operations,
      contextMode: authorization.contextMode
    };
  }
}

const context: PromptResolutionContext = {
  workspaceId: 'workspace-1',
  actorUserId: 'user-1',
  mode: 'launch'
};

test('a provider-only registration resolves a new type without generic code changes', async () => {
  const registry = new PromptResourceRegistry().register(new ContractProvider('finding'));
  const resolved = await registry.resolve('Compare @finding[Outage] and @finding[Latency].', context);
  assert.deepEqual(resolved.bindings.map((binding) => binding.resourceId), ['outage', 'latency']);
  assert.deepEqual(resolved.blockers, []);
  assert.match(resolved.promptDigest, /^[a-f0-9]{64}$/);
  assert.match(resolved.bindingDigest, /^[a-f0-9]{64}$/);
});

test('mixed providers preserve order and report independent provider failures', async () => {
  const registry = new PromptResourceRegistry()
    .register(new ContractProvider('finding'))
    .register(new ContractProvider('artifact', 'missing'));
  const resolved = await registry.resolve('Use @artifact[Report] with @finding[Outage].', context);
  assert.equal(resolved.candidates[0], null);
  assert.equal(resolved.candidates[1]?.type, 'finding');
  assert.deepEqual(resolved.bindings.map((binding) => binding.type), ['finding']);
  assert.equal(resolved.blockers[0]?.code, 'PROMPT_REFERENCE_NOT_FOUND');
  assert.equal(resolved.blockers[0]?.tokenIndex, 0);
});

test('registry rejects duplicate providers, duplicate resources, and provider cardinality overflow', async () => {
  const registry = new PromptResourceRegistry().register(new ContractProvider('run', 'ok', 1));
  assert.throws(() => registry.register(new ContractProvider('run')), /Duplicate/);
  const resolved = await registry.resolve('Compare @run[One] with @run[One].', context);
  assert.ok(resolved.blockers.some((item) => item.code === 'PROMPT_REFERENCE_DUPLICATE'));
  assert.ok(resolved.blockers.some((item) => item.code === 'PROMPT_REFERENCE_CARDINALITY'));
});

test('prompt and binding digests are deterministic', async () => {
  const registry = new PromptResourceRegistry().register(new ContractProvider('artifact'));
  const left = await registry.resolve('Read @artifact[Report].', context);
  const right = await registry.resolve('Read @artifact[Report].', context);
  assert.equal(left.promptDigest, right.promptDigest);
  assert.equal(left.bindingDigest, right.bindingDigest);
  assert.equal(left.bindings[0]?.bindingId, right.bindings[0]?.bindingId);
});

test('binding digest matches the cross-service canonical contract vector', () => {
  const vector = JSON.parse(readFileSync(
    new URL('../fixtures/resource-binding-digest-conformance.json', import.meta.url),
    'utf8'
  )) as { bindings: PromptResourceBinding[]; sha256: string };
  assert.equal(digestBindings(vector.bindings), vector.sha256);
});
