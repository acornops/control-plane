import { createHash } from 'node:crypto';
import type {
  PromptReferenceBlocker,
  PromptReferenceResolution,
  PromptReferenceToken,
  PromptReferenceTypeDescriptor,
  PromptResolutionContext,
  PromptResourceBinding,
  PromptResourceCandidate,
  PromptResourceProvider,
  PromptResourceSuggestionContext
} from '../../types/prompt-resources.js';
import { canonicalJson } from '../canonical-json.js';
import { boundedProviderMessage, PromptResourceProviderError } from './errors.js';
import { parsePromptReferences } from './parser.js';

const PROVIDER_TIMEOUT_MS = 3_000;
const MAX_BINDING_BYTES = 16_384;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;

export function digestPrompt(prompt: string): string {
  return createHash('sha256').update(prompt.normalize('NFC'), 'utf8').digest('hex');
}

export function digestBindings(bindings: PromptResourceBinding[]): string {
  return createHash('sha256').update(canonicalJson(bindings), 'utf8').digest('hex');
}

export interface PromptResourceResolutionOptions {
  enforceCardinality?: boolean;
  includeImplicit?: boolean;
}

function bindingId(binding: Omit<PromptResourceBinding, 'bindingId'>): string {
  return `prb_${createHash('sha256').update(canonicalJson(binding), 'utf8').digest('hex').slice(0, 24)}`;
}

function validateCandidate(
  descriptor: PromptReferenceTypeDescriptor,
  type: string,
  candidate: PromptResourceCandidate,
  expectedId?: string
): PromptResourceCandidate {
  if (!candidate
    || candidate.type !== type
    || candidate.provider !== descriptor.provider
    || typeof candidate.id !== 'string'
    || !candidate.id
    || (expectedId !== undefined && candidate.id !== expectedId)
    || typeof candidate.label !== 'string'
    || !candidate.label.trim()
    || CONTROL_CHARACTER.test(candidate.label)
    || (candidate.description !== undefined && typeof candidate.description !== 'string')
    || (candidate.unavailableReason !== undefined && typeof candidate.unavailableReason !== 'string')
    || (candidate.availability !== 'available' && candidate.availability !== 'unavailable')
    || (candidate.metadata !== undefined
      && (!candidate.metadata || typeof candidate.metadata !== 'object' || Array.isArray(candidate.metadata)))) {
    throw new PromptResourceProviderError(
      'PROMPT_REFERENCE_DENIED',
      'The prompt resource provider returned an invalid candidate identity.'
    );
  }
  return {
    ...candidate,
    label: candidate.label.normalize('NFC')
  };
}

function validateBoundResource(
  descriptor: PromptReferenceTypeDescriptor,
  type: string,
  candidate: PromptResourceCandidate,
  bound: Omit<PromptResourceBinding, 'bindingId'>,
  context: PromptResolutionContext
): PromptResourceBinding {
  const expectedSource = context.source || 'explicit';
  const requiredOperations = [...new Set((context.requirements || [])
    .filter((requirement) => requirement.type === type)
    .flatMap((requirement) => requirement.requiredOperations))];
  if (!bound
    || typeof bound !== 'object'
    || bound.type !== type
    || bound.resourceId !== candidate.id
    || bound.provider !== descriptor.provider
    || bound.providerVersion !== descriptor.providerVersion
    || bound.workspaceId !== context.workspaceId
    || bound.labelSnapshot !== candidate.label
    || bound.source !== expectedSource
    || !['inline', 'tool', 'routing_only'].includes(bound.contextMode)
    || !Array.isArray(bound.operations)
    || bound.operations.length > 64
    || new Set(bound.operations).size !== bound.operations.length
    || bound.operations.some((operation) => typeof operation !== 'string' || !operation)
    || requiredOperations.some((operation) => !bound.operations.includes(operation))
    || (bound.providerData !== undefined
      && (!bound.providerData || typeof bound.providerData !== 'object' || Array.isArray(bound.providerData)))) {
    throw new PromptResourceProviderError(
      'PROMPT_REFERENCE_DENIED',
      'The prompt resource provider returned an invalid binding identity.'
    );
  }
  if (Buffer.byteLength(canonicalJson(bound), 'utf8') > MAX_BINDING_BYTES) {
    throw new PromptResourceProviderError(
      'PROMPT_REFERENCE_DENIED',
      'The prompt resource binding exceeds the platform size limit.'
    );
  }
  return { ...bound, bindingId: bindingId(bound) };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new PromptResourceProviderError(
          'PROMPT_REFERENCE_PROVIDER_TIMEOUT',
          'The prompt resource provider timed out.',
          true
        )), PROVIDER_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function blocker(error: unknown, token?: PromptReferenceToken, tokenIndex?: number): PromptReferenceBlocker {
  if (error instanceof PromptResourceProviderError) {
    return {
      code: error.code,
      message: boundedProviderMessage(error.message),
      tokenIndex,
      type: token?.type,
      retryable: error.retryable
    };
  }
  return {
    code: 'PROMPT_REFERENCE_UNAVAILABLE',
    message: 'The prompt resource provider is temporarily unavailable.',
    tokenIndex,
    type: token?.type,
    retryable: true
  };
}

export class PromptResourceRegistry {
  private readonly providers = new Map<string, PromptResourceProvider>();

  register(provider: PromptResourceProvider): this {
    const descriptor = provider.descriptor();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(descriptor.type)) {
      throw new Error(`Invalid prompt resource provider type: ${descriptor.type}`);
    }
    if (this.providers.has(descriptor.type)) {
      throw new Error(`Duplicate prompt resource provider type: ${descriptor.type}`);
    }
    this.providers.set(descriptor.type, provider);
    return this;
  }

  descriptors(): PromptReferenceTypeDescriptor[] {
    return [...this.providers.values()]
      .map((provider) => provider.descriptor())
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.type.localeCompare(right.type));
  }

  provider(type: string): PromptResourceProvider | null {
    return this.providers.get(type) || null;
  }

  projectRuntime(bindings: PromptResourceBinding[], runId: string): Record<string, unknown> {
    const projection: Record<string, unknown> = {};
    for (const binding of bindings) {
      const provider = this.provider(binding.type);
      if (!provider || provider.descriptor().provider !== binding.provider) {
        throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', 'A bound prompt resource provider is not registered.');
      }
      const contribution = provider.projectRuntime?.(binding, { runId }) || {};
      for (const [key, value] of Object.entries(contribution)) {
        if (projection[key] !== undefined && canonicalJson(projection[key]) !== canonicalJson(value)) {
          throw new PromptResourceProviderError('PROMPT_REFERENCE_CARDINALITY', `Prompt resource providers produced conflicting ${key} runtime projections.`);
        }
        projection[key] = value;
      }
    }
    return projection;
  }

  async suggest(type: string, context: PromptResourceSuggestionContext): Promise<PromptResourceCandidate[]> {
    const provider = this.provider(type);
    if (!provider) {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_UNKNOWN_TYPE', `Unknown prompt reference type: ${type}.`);
    }
    const descriptor = provider.descriptor();
    if (descriptor.availability === 'unavailable') {
      throw new PromptResourceProviderError(
        'PROMPT_REFERENCE_UNAVAILABLE',
        descriptor.unavailableReason || `${descriptor.displayName} references are unavailable.`
      );
    }
    const candidates = await bounded(provider.suggest(context));
    if (!Array.isArray(candidates)) {
      throw new PromptResourceProviderError(
        'PROMPT_REFERENCE_DENIED',
        'The prompt resource provider returned an invalid suggestion collection.'
      );
    }
    return candidates
      .slice(0, context.limit)
      .map((candidate) => validateCandidate(descriptor, type, candidate));
  }

  async resolveById(
    type: string,
    resourceId: string,
    context: PromptResolutionContext
  ): Promise<{ candidate: PromptResourceCandidate; binding: PromptResourceBinding }> {
    const provider = this.provider(type);
    if (!provider) {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_UNKNOWN_TYPE', `Unknown prompt reference type: ${type}.`);
    }
    const descriptor = provider.descriptor();
    if (!provider.resolveById) {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', `${descriptor.displayName} does not support runtime parameter selection.`);
    }
    const candidate = validateCandidate(
      descriptor,
      type,
      await bounded(provider.resolveById(resourceId, context)),
      resourceId
    );
    if (candidate.availability !== 'available') {
      throw new PromptResourceProviderError(
        'PROMPT_REFERENCE_UNAVAILABLE',
        candidate.unavailableReason || 'The selected resource is unavailable.',
        true
      );
    }
    const authorization = await bounded(provider.authorize(candidate, context));
    const bound = await bounded(provider.bind(candidate, authorization, {
      ...context,
      source: context.source || 'explicit'
    }));
    return {
      candidate,
      binding: validateBoundResource(descriptor, type, candidate, bound, context)
    };
  }

  async resolve(
    prompt: string,
    context: PromptResolutionContext,
    options: PromptResourceResolutionOptions = {}
  ): Promise<PromptReferenceResolution> {
    const parsed = parsePromptReferences(prompt);
    const blockers: PromptReferenceBlocker[] = parsed.errors.map((error) => ({
      code: error.code,
      message: error.message,
      retryable: false
    }));
    const candidates: Array<PromptResourceCandidate | null> = Array.from({ length: parsed.tokens.length }, () => null);
    const bindingsByIndex: Array<PromptResourceBinding | null> = Array.from({ length: parsed.tokens.length }, () => null);
    const duplicateKeys = new Set<string>();

    const groups = new Map<string, Array<{ token: PromptReferenceToken; index: number }>>();
    parsed.tokens.forEach((token, index) => {
      const values = groups.get(token.type) || [];
      values.push({ token, index });
      groups.set(token.type, values);
    });

    await Promise.all([...groups.entries()].map(async ([type, values]) => {
      const provider = this.provider(type);
      if (!provider) {
        values.forEach(({ token, index }) => blockers.push({
          code: 'PROMPT_REFERENCE_UNKNOWN_TYPE',
          message: `Unknown prompt reference type: ${type}.`,
          tokenIndex: index,
          type: token.type,
          retryable: false
        }));
        return;
      }
      const descriptor = provider.descriptor();
      if (descriptor.availability === 'unavailable') {
        values.forEach(({ token, index }) => blockers.push({
          code: 'PROMPT_REFERENCE_UNAVAILABLE',
          message: descriptor.unavailableReason || `${descriptor.displayName} references are unavailable.`,
          tokenIndex: index,
          type: token.type,
          retryable: false
        }));
        return;
      }
      for (const { token, index } of values) {
        try {
          const candidate = validateCandidate(
            descriptor,
            type,
            await bounded(provider.resolve(token, context))
          );
          if (candidate.availability !== 'available') {
            throw new PromptResourceProviderError('PROMPT_REFERENCE_UNAVAILABLE', candidate.unavailableReason || 'The referenced resource is unavailable.', true);
          }
          candidates[index] = candidate;
          const key = `${candidate.provider}\u0000${candidate.type}\u0000${candidate.id}`;
          if (duplicateKeys.has(key)) {
            blockers.push({
              code: 'PROMPT_REFERENCE_DUPLICATE',
              message: `The same ${descriptor.displayName} resource is referenced more than once.`,
              tokenIndex: index,
              type: token.type,
              retryable: false
            });
            continue;
          }
          duplicateKeys.add(key);
          const authorization = await bounded(provider.authorize(candidate, context));
          const bound = await bounded(provider.bind(candidate, authorization, {
            ...context,
            source: context.source || 'explicit'
          }));
          bindingsByIndex[index] = validateBoundResource(descriptor, type, candidate, bound, context);
        } catch (error) {
          blockers.push(blocker(error, token, index));
        }
      }
    }));

    if (options.enforceCardinality !== false) {
      const explicitCounts = new Map<string, number>();
      parsed.tokens.forEach((token) => explicitCounts.set(token.type, (explicitCounts.get(token.type) || 0) + 1));
      for (const provider of this.providers.values()) {
        const descriptor = provider.descriptor();
        const count = explicitCounts.get(descriptor.type) || 0;
        if (count < descriptor.minimum || count > descriptor.maximum) {
          blockers.push({
            code: 'PROMPT_REFERENCE_CARDINALITY',
            message: `Prompt permits between ${descriptor.minimum} and ${descriptor.maximum} ${descriptor.type} references; found ${count}.`,
            type: descriptor.type,
            retryable: false
          });
        }
      }
      for (const requirement of context.requirements || []) {
        if (!this.provider(requirement.type)) {
          blockers.push({
            code: 'PROMPT_REFERENCE_UNKNOWN_TYPE',
            message: `Unknown prompt resource requirement type: ${requirement.type}.`,
            type: requirement.type,
            retryable: false
          });
          continue;
        }
        const count = explicitCounts.get(requirement.type) || 0;
        if (count < requirement.minimum || count > requirement.maximum) {
          blockers.push({
            code: 'PROMPT_REFERENCE_CARDINALITY',
            message: `Prompt requires between ${requirement.minimum} and ${requirement.maximum} ${requirement.type} references; found ${count}.`,
            type: requirement.type,
            retryable: false
          });
        }
      }
    }

    const bindings = bindingsByIndex.filter((value): value is PromptResourceBinding => Boolean(value));
    const includeImplicit = options.includeImplicit ?? Boolean(context.workflowSessionId);
    if (context.workflowSessionId && includeImplicit) {
      if (bindings.length >= 64) {
        blockers.push({
          code: 'PROMPT_REFERENCE_CARDINALITY',
          message: 'Prompt resource bindings exceed the aggregate run limit.',
          retryable: false
        });
      }
      const implicitProviders = [...this.providers.values()].filter((provider) => provider.descriptor().implicit);
      for (const implicitProvider of implicitProviders) {
        if (bindings.length >= 64) break;
        try {
          const implicitDescriptor = implicitProvider.descriptor();
          const implicitToken: PromptReferenceToken = {
            type: implicitDescriptor.type,
            label: context.workflowSessionId,
            start: parsed.prompt.length,
            end: parsed.prompt.length
          };
          const candidate = validateCandidate(
            implicitDescriptor,
            implicitDescriptor.type,
            await bounded(implicitProvider.resolve(implicitToken, context)),
            context.workflowSessionId
          );
          if (candidate.availability !== 'available') {
            throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', 'An implicit prompt resource provider returned an invalid candidate.');
          }
          const authorization = await bounded(implicitProvider.authorize(candidate, context));
          const bound = await bounded(implicitProvider.bind(candidate, authorization, { ...context, source: 'implicit' }));
          if (bound.type !== implicitDescriptor.type || bound.resourceId !== candidate.id
            || bound.provider !== implicitDescriptor.provider || bound.providerVersion !== implicitDescriptor.providerVersion
            || bound.workspaceId !== context.workspaceId || bound.source !== 'implicit') {
            throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', 'An implicit prompt resource provider returned an invalid binding.');
          }
          if (Buffer.byteLength(canonicalJson(bound), 'utf8') > MAX_BINDING_BYTES) {
            throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', 'The implicit prompt resource binding exceeds the platform size limit.');
          }
          bindings.push({ ...bound, bindingId: bindingId(bound) });
        } catch (error) {
          blockers.push(blocker(error));
        }
      }
    }

    const orderedBlockers = [...blockers].sort((left, right) => (
      (left.tokenIndex ?? Number.MAX_SAFE_INTEGER) - (right.tokenIndex ?? Number.MAX_SAFE_INTEGER)
      || (left.type || '').localeCompare(right.type || '')
      || left.code.localeCompare(right.code)
      || left.message.localeCompare(right.message)
    ));
    return {
      prompt: parsed.prompt,
      promptDigest: digestPrompt(parsed.prompt),
      bindingDigest: digestBindings(bindings),
      tokens: parsed.tokens,
      candidates,
      bindings,
      blockers: orderedBlockers,
      resolvedAt: new Date().toISOString()
    };
  }
}
