import type { WorkspaceAuthorization } from '../auth/workspace-authorization.js';
import {
  capabilityForToolAccessMode,
  missingToolAccessModeCapabilityMessage,
  parseToolAccessMode,
  resolveRunToolAccessMode
} from '../services/run-tool-access-mode.js';
import type { ChatSession, ToolAccessMode } from '../types/domain.js';

type SessionMessageAccess =
  | {
      allowed: true;
      sharedAutomaticSession: boolean;
      toolAccessMode: ToolAccessMode;
    }
  | {
      allowed: false;
      code: 'CONVERSATION_OWNER_REQUIRED' | 'FORBIDDEN';
      message: string;
    };

export function resolveSessionMessageAccess(input: {
  authz: WorkspaceAuthorization;
  credentialType: string;
  requestedToolAccessMode: unknown;
  session: ChatSession;
  userId: string;
}): SessionMessageAccess {
  const sharedAutomaticSession = input.session.origin === 'auto_triage'
    && input.credentialType === 'session';
  if (!sharedAutomaticSession && input.session.createdBy !== input.userId) {
    return {
      allowed: false,
      code: 'CONVERSATION_OWNER_REQUIRED',
      message: 'Only the user who started this conversation can send follow-up messages.'
    };
  }
  if (sharedAutomaticSession && !input.authz.can('create_sessions')) {
    return {
      allowed: false,
      code: 'FORBIDDEN',
      message: 'Replying to a shared automatic investigation requires session creation capability.'
    };
  }
  const requested = parseToolAccessMode(input.requestedToolAccessMode);
  const permitted = resolveRunToolAccessMode(input.authz, requested);
  const toolAccessMode = sharedAutomaticSession
    && input.session.automaticInvestigation?.effectiveToolMode === 'read_only'
    ? 'read_only'
    : permitted;
  if (!input.authz.can(capabilityForToolAccessMode(toolAccessMode))) {
    return {
      allowed: false,
      code: 'FORBIDDEN',
      message: missingToolAccessModeCapabilityMessage(toolAccessMode)
    };
  }
  return { allowed: true, sharedAutomaticSession, toolAccessMode };
}
