import type { WorkspaceAuditOperation } from '../types/domain.js';

export type NativeToolAuthorizationClass = 'selected_context' | 'internal_artifact';
export type NativeToolInvocationScope = 'workflow' | 'target_chat';

export interface WorkspaceNativeToolDefinition {
  id: string;
  modelAlias: string;
  title: string;
  description: string;
  semanticCapabilityId: string;
  invocationScopes: NativeToolInvocationScope[];
  authorizationClass: NativeToolAuthorizationClass;
  auditOperation: WorkspaceAuditOperation;
  approvalOperation: WorkspaceAuditOperation;
  requiredContextGrant?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

const WORKSPACE_NATIVE_TOOLS: WorkspaceNativeToolDefinition[] = [
  {
    id: 'chat.sessions.read_selected',
    modelAlias: 'acornops_read_selected_chat_sessions',
    title: 'Read selected chats',
    description: 'Read bounded message evidence from chat sessions explicitly selected for this workflow run.',
    semanticCapabilityId: 'chat.sessions.read_selected',
    invocationScopes: ['workflow'],
    authorizationClass: 'selected_context',
    auditOperation: 'read',
    approvalOperation: 'read',
    requiredContextGrant: 'selected_chat_sessions',
    inputSchema: {
      type: 'object',
      required: ['sessionIds'],
      additionalProperties: false,
      properties: {
        sessionIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1 } }
      }
    },
    outputSchema: { type: 'object', required: ['sessions'], properties: { sessions: { type: 'array' } } }
  },
  {
    id: 'reports.pdf.generate',
    modelAlias: 'acornops_generate_pdf_report',
    title: 'Generate PDF report',
    description: 'Call only when the user explicitly requests a PDF incident report. Compose complete incident-report Markdown from the current run chat and available evidence, label unknown facts explicitly, then persist the bounded, provenance-linked PDF. Do not claim the report exists unless this function succeeds.',
    semanticCapabilityId: 'reports.pdf.generate',
    invocationScopes: ['workflow', 'target_chat'],
    authorizationClass: 'internal_artifact',
    auditOperation: 'write',
    approvalOperation: 'read',
    inputSchema: {
      type: 'object',
      required: ['title', 'markdown'],
      additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        markdown: { type: 'string', minLength: 1, maxLength: 262144 },
        provenance: { type: 'object' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['reportId', 'mediaType', 'downloadUrl'],
      properties: {
        reportId: { type: 'string' },
        mediaType: { const: 'application/pdf' },
        downloadUrl: { type: 'string' }
      }
    }
  }
];

export function listWorkspaceNativeTools(): WorkspaceNativeToolDefinition[] {
  return WORKSPACE_NATIVE_TOOLS.map((tool) => ({ ...tool }));
}

export function listWorkspaceNativeToolsForInvocationScope(
  invocationScope: NativeToolInvocationScope
): WorkspaceNativeToolDefinition[] {
  return listWorkspaceNativeTools().filter((tool) => tool.invocationScopes.includes(invocationScope));
}

export function getWorkspaceNativeTool(toolId: string): WorkspaceNativeToolDefinition | null {
  return WORKSPACE_NATIVE_TOOLS.find((tool) => tool.id === toolId) || null;
}

export function isWorkspaceNativeToolName(toolId: string): boolean {
  return WORKSPACE_NATIVE_TOOLS.some((tool) => tool.id === toolId);
}
