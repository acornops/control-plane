import { repo } from '../store/repository.js';
import type { WorkflowDefinitionForAccess, WorkflowRepositoryScope } from '../types/workflows.js';

export class WorkflowInputValidationError extends Error {
  constructor(readonly code: string, message: string, readonly field: string) {
    super(message);
    this.name = 'WorkflowInputValidationError';
  }
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function promptReferenceLabel(label: string): string {
  return label.replaceAll('\\', '\\\\').replaceAll(']', '\\]');
}

export function workflowChatPromptReference(title: string): string {
  return `@chat[${promptReferenceLabel(title)}]`;
}

function repositoryScope(value: unknown, field: string): WorkflowRepositoryScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowInputValidationError('WORKFLOW_REPOSITORY_INVALID', 'Select a valid GitHub or GitLab repository.', field);
  }
  const raw = value as Record<string, unknown>;
  const provider = raw.provider;
  const repository = typeof raw.repository === 'string' ? raw.repository.trim().replace(/\.git$/i, '') : '';
  if ((provider !== 'github' && provider !== 'gitlab')
    || repository.length > 255
    || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(repository)
    || repository.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new WorkflowInputValidationError('WORKFLOW_REPOSITORY_INVALID', 'Repository must be a provider-relative owner or project path.', field);
  }
  const ref = typeof raw.ref === 'string' ? raw.ref.trim() : '';
  if (ref.length > 255 || /[\u0000-\u001f\u007f]/u.test(ref)) {
    throw new WorkflowInputValidationError('WORKFLOW_REPOSITORY_REF_INVALID', 'Repository ref is invalid.', field);
  }
  const changeRequest = raw.changeRequest && typeof raw.changeRequest === 'object' && !Array.isArray(raw.changeRequest)
    ? raw.changeRequest as Record<string, unknown>
    : undefined;
  let changeRequestNumber: number | undefined;
  if (changeRequest) {
    const expectedType = provider === 'github' ? 'pull_request' : 'merge_request';
    if (changeRequest.type !== expectedType
      || !Number.isInteger(changeRequest.number)
      || (changeRequest.number as number) < 1) {
      throw new WorkflowInputValidationError('WORKFLOW_CHANGE_REQUEST_INVALID', `Select a valid ${provider === 'github' ? 'pull request' : 'merge request'}.`, field);
    }
    changeRequestNumber = changeRequest.number as number;
  }
  return {
    provider,
    repository,
    ...(ref ? { ref } : {}),
    ...(changeRequestNumber ? { changeRequestNumber } : {})
  };
}

export function resolveWorkflowRepositoryScope(
  workflow: WorkflowDefinitionForAccess,
  inputs: Record<string, unknown>
): WorkflowRepositoryScope | undefined {
  const input = (workflow.inputs || []).find((candidate) => candidate.type === 'repository');
  if (!input || isMissing(inputs[input.name])) return undefined;
  return repositoryScope(inputs[input.name], input.name);
}

export async function validateWorkflowInputs(params: {
  workspaceId: string;
  workflow: WorkflowDefinitionForAccess;
  inputs: Record<string, unknown>;
  content?: string;
}): Promise<void> {
  for (const input of params.workflow.inputs || []) {
    const value = params.inputs[input.name];
    if (input.required && isMissing(value)) {
      throw new WorkflowInputValidationError(
        'WORKFLOW_INPUT_REQUIRED',
        `${input.label} is required before launching this workflow.`,
        input.name
      );
    }
    if (input.type === 'repository' && !isMissing(value)) {
      repositoryScope(value, input.name);
      continue;
    }
    if (input.type !== 'chat_session_list' || isMissing(value)) continue;
    if (!Array.isArray(value) || value.length > 50 || value.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new WorkflowInputValidationError(
        'WORKFLOW_CHAT_SESSIONS_INVALID',
        `${input.label} must contain valid chat session IDs.`,
        input.name
      );
    }
    const sessionIds = [...new Set(value as string[])];
    const sessions = await Promise.all(sessionIds.map((sessionId) => repo.getSession(sessionId)));
    if (sessions.some((session) => !session || session.workspaceId !== params.workspaceId || session.status !== 'open')) {
      throw new WorkflowInputValidationError(
        'WORKFLOW_CHAT_SESSION_UNAVAILABLE',
        'One or more selected incident chats are unavailable in this workspace.',
        input.name
      );
    }
    const missingMention = params.content?.trim() && sessions.some((session) => (
      session && !params.content!.toLocaleLowerCase().includes(workflowChatPromptReference(session.title).toLocaleLowerCase())
    ));
    if (missingMention) {
      throw new WorkflowInputValidationError(
        'WORKFLOW_CHAT_MENTION_MISMATCH',
        'Every selected incident chat must be explicitly referenced in the control message.',
        input.name
      );
    }
  }
}
