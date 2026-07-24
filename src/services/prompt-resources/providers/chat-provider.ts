import { db } from '../../../infra/db.js';
import { repo } from '../../../store/repository.js';
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

interface ChatRow {
  id: string;
  title: string;
  target_id: string;
  target_name: string;
  target_type: string;
}

const descriptor: PromptReferenceTypeDescriptor = {
  type: 'chat',
  displayName: 'Chat',
  description: 'An active target chat in this workspace.',
  icon: 'chat',
  placeholderLabel: 'Chat title',
  availability: 'available',
  minimum: 0,
  maximum: 20,
  allowPinnedReferences: true,
  provider: 'acornops.target-chat',
  providerVersion: '1'
};

function normalized(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase();
}

async function chats(workspaceId: string): Promise<ChatRow[]> {
  const result = await db.query<ChatRow>(
    `SELECT session.id, session.title, session.target_id, target.name AS target_name, target.target_type
     FROM sessions session
     JOIN targets target ON target.id=session.target_id AND target.workspace_id=session.workspace_id
     WHERE session.workspace_id=$1 AND session.status='open' AND session.deleted_at IS NULL AND session.expires_at>NOW()
     ORDER BY session.last_message_at DESC,session.id DESC`,
    [workspaceId]
  );
  return result.rows;
}

function candidate(row: ChatRow): PromptResourceCandidate {
  return {
    type: descriptor.type,
    id: row.id,
    label: row.title,
    description: row.target_name,
    provider: descriptor.provider,
    availability: 'available',
    metadata: { targetId: row.target_id, targetType: row.target_type }
  };
}

export class ChatPromptResourceProvider implements PromptResourceProvider {
  descriptor(): PromptReferenceTypeDescriptor { return { ...descriptor }; }

  async suggest(context: PromptResourceSuggestionContext): Promise<PromptResourceCandidate[]> {
    const query = normalized(context.query);
    return (await chats(context.workspaceId))
      .filter((row) => !query || normalized(row.title).includes(query))
      .slice(0, context.limit)
      .map(candidate);
  }

  async resolve(token: PromptReferenceToken, context: PromptResolutionContext): Promise<PromptResourceCandidate> {
    const matches = (await chats(context.workspaceId)).filter((row) => normalized(row.title) === normalized(token.label));
    if (matches.length === 0) throw new PromptResourceProviderError('PROMPT_REFERENCE_NOT_FOUND', 'The referenced chat is not active in this workspace.');
    if (matches.length > 1) throw new PromptResourceProviderError('PROMPT_REFERENCE_AMBIGUOUS', 'The referenced chat title is ambiguous.');
    return candidate(matches[0]);
  }

  async resolveById(resourceId: string, context: PromptResolutionContext): Promise<PromptResourceCandidate> {
    const row = (await chats(context.workspaceId)).find((value) => value.id === resourceId);
    if (!row) throw new PromptResourceProviderError('PROMPT_REFERENCE_NOT_FOUND', 'The selected chat is not active in this workspace.');
    return candidate(row);
  }

  async authorize(candidateValue: PromptResourceCandidate, context: PromptResolutionContext): Promise<PromptResourceAuthorization> {
    const session = await repo.getSession(candidateValue.id);
    if (!session || session.workspaceId !== context.workspaceId || session.status !== 'open') {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', 'The referenced chat is not available to this workspace.');
    }
    const operations = [...new Set((context.requirements || [])
      .filter((requirement) => requirement.type === descriptor.type)
      .flatMap((requirement) => requirement.requiredOperations))].sort();
    if (operations.some((operation) => operation !== 'read')) {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', 'Chat references support read access only.');
    }
    return {
      operations: operations.length > 0 ? operations : ['read'],
      contextMode: 'tool',
      providerData: { targetId: session.targetId, targetType: session.targetType }
    };
  }

  async bind(
    candidateValue: PromptResourceCandidate,
    authorization: PromptResourceAuthorization,
    context: PromptResolutionContext
  ): Promise<Omit<PromptResourceBinding, 'bindingId'>> {
    return {
      type: candidateValue.type,
      resourceId: candidateValue.id,
      provider: descriptor.provider,
      providerVersion: descriptor.providerVersion,
      workspaceId: context.workspaceId,
      labelSnapshot: candidateValue.label,
      source: context.source || 'explicit',
      operations: authorization.operations,
      contextMode: authorization.contextMode,
      providerData: authorization.providerData
    };
  }

  async loadContext(binding: PromptResourceBinding, context: { runId: string; maximumBytes: number }): Promise<Record<string, unknown>> {
    const session = await repo.getSession(binding.resourceId);
    if (!session || session.workspaceId !== binding.workspaceId) {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_NOT_FOUND', 'Bound chat is no longer available.');
    }
    const messages = await repo.listMessages(session.id, { limit: 200 });
    const bounded: Array<Record<string, unknown>> = [];
    let bytes = 0;
    for (const message of [...messages.items].reverse()) {
      const value = { id: message.id, role: message.role, content: message.content, createdAt: message.createdAt };
      const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (bytes + size > context.maximumBytes) break;
      bytes += size;
      bounded.push(value);
    }
    return { messages: bounded, truncated: bounded.length < messages.items.length };
  }
}
