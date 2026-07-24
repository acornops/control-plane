import { getWorkflowSession, listWorkflowMessages } from '../../../store/repository-workflows.js';
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
  type: 'workflow_session',
  displayName: 'Current Workflow conversation',
  description: 'The Workflow conversation through the message that initiated this run.',
  icon: 'workflow-session',
  placeholderLabel: '',
  availability: 'available',
  minimum: 0,
  maximum: 1,
  allowPinnedReferences: false,
  implicit: true,
  provider: 'acornops.workflow-session',
  providerVersion: '1'
};

export class WorkflowSessionPromptResourceProvider implements PromptResourceProvider {
  descriptor(): PromptReferenceTypeDescriptor { return { ...descriptor }; }
  async suggest(_context: PromptResourceSuggestionContext): Promise<PromptResourceCandidate[]> { return []; }

  async resolve(token: PromptReferenceToken, context: PromptResolutionContext): Promise<PromptResourceCandidate> {
    const sessionId = context.workflowSessionId || token.label;
    const session = sessionId ? await getWorkflowSession(sessionId) : null;
    if (!session || session.workspaceId !== context.workspaceId) {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', 'The current Workflow conversation is unavailable.');
    }
    return {
      type: descriptor.type,
      id: session.id,
      label: 'Current Workflow conversation',
      provider: descriptor.provider,
      availability: 'available'
    };
  }

  async authorize(_candidate: PromptResourceCandidate, context: PromptResolutionContext): Promise<PromptResourceAuthorization> {
    if (!context.initiatingMessageId) {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', 'The initiating Workflow message is required to bind conversation context.');
    }
    return {
      operations: ['read'],
      contextMode: 'inline',
      providerData: { throughMessageId: context.initiatingMessageId }
    };
  }

  async bind(
    candidate: PromptResourceCandidate,
    authorization: PromptResourceAuthorization,
    context: PromptResolutionContext
  ): Promise<Omit<PromptResourceBinding, 'bindingId'>> {
    return {
      type: candidate.type,
      resourceId: candidate.id,
      provider: descriptor.provider,
      providerVersion: descriptor.providerVersion,
      workspaceId: context.workspaceId,
      labelSnapshot: candidate.label,
      source: 'implicit',
      operations: authorization.operations,
      contextMode: authorization.contextMode,
      providerData: authorization.providerData
    };
  }

  async loadContext(binding: PromptResourceBinding, context: { runId: string; maximumBytes: number }): Promise<Record<string, unknown>> {
    const throughMessageId = binding.providerData?.throughMessageId;
    if (typeof throughMessageId !== 'string') {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', 'Workflow conversation binding is missing its message boundary.');
    }
    const messages = await listWorkflowMessages(binding.resourceId);
    const throughIndex = messages.findIndex((message) => message.id === throughMessageId);
    if (throughIndex < 0) throw new PromptResourceProviderError('PROMPT_REFERENCE_NOT_FOUND', 'The initiating Workflow message no longer exists.');
    const bounded: Array<Record<string, unknown>> = [];
    let bytes = 0;
    for (const message of messages.slice(0, throughIndex + 1)) {
      const value = { id: message.id, role: message.role, content: message.content, createdAt: message.createdAt };
      const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (bytes + size > context.maximumBytes) break;
      bytes += size;
      bounded.push(value);
    }
    return { messages: bounded, throughMessageId, truncated: bounded.length < throughIndex + 1 };
  }
}
