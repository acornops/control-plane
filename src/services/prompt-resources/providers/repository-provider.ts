import type {
  PromptReferenceToken,
  PromptReferenceTypeDescriptor,
  PromptResolutionContext,
  PromptResourceAuthorization,
  PromptResourceBinding,
  PromptResourceCandidate,
  PromptResourceProvider,
  PromptResourceSuggestionContext
} from '../../../types/prompt-resources.js';
import { PromptResourceProviderError } from '../errors.js';

const descriptor: PromptReferenceTypeDescriptor = {
  type: 'repository',
  displayName: 'Repository',
  description: 'A repository exposed by an installed source-control integration.',
  icon: 'repository',
  placeholderLabel: 'Repository',
  availability: 'unavailable',
  unavailableReason: 'Install and authorize a compatible source-control integration to use repository references.',
  minimum: 0,
  maximum: 20,
  allowPinnedReferences: true,
  provider: 'acornops.source-control',
  providerVersion: '1'
};

export class RepositoryPromptResourceProvider implements PromptResourceProvider {
  descriptor(): PromptReferenceTypeDescriptor { return { ...descriptor }; }
  async suggest(_context: PromptResourceSuggestionContext): Promise<PromptResourceCandidate[]> { return []; }
  async resolve(_token: PromptReferenceToken, _context: PromptResolutionContext): Promise<PromptResourceCandidate> {
    throw new PromptResourceProviderError('PROMPT_REFERENCE_UNAVAILABLE', descriptor.unavailableReason!);
  }
  async authorize(_candidate: PromptResourceCandidate, _context: PromptResolutionContext): Promise<PromptResourceAuthorization> {
    throw new PromptResourceProviderError('PROMPT_REFERENCE_UNAVAILABLE', descriptor.unavailableReason!);
  }
  async bind(
    _candidate: PromptResourceCandidate,
    _authorization: PromptResourceAuthorization,
    _context: PromptResolutionContext
  ): Promise<Omit<PromptResourceBinding, 'bindingId'>> {
    throw new PromptResourceProviderError('PROMPT_REFERENCE_UNAVAILABLE', descriptor.unavailableReason!);
  }
}
