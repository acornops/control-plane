import { repo } from '../store/repository.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';

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
