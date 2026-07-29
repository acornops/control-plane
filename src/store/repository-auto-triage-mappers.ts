import type { AutoTriageWriteMode } from '../types/auto-triage.js';
import type { ChatSession, Message, TargetIssueSeverity, ToolAccessMode } from '../types/domain.js';

export interface AutomaticSessionRowFields {
  origin: ChatSession['origin'];
  linked_issue_id: string | null;
  linked_issue_lifecycle_version: number | string | null;
  linked_issue_severity?: TargetIssueSeverity | null;
  linked_issue_scope_kind?: string | null;
  linked_issue_scope_name?: string | null;
  linked_issue_object_kind?: string | null;
  linked_issue_object_name?: string | null;
  auto_triage_write_mode: AutoTriageWriteMode | null;
  auto_triage_effective_tool_mode: ToolAccessMode | null;
  auto_triage_confirmation_required: boolean | null;
}

export interface MessageAuthorRowFields {
  created_by: string | null;
  created_by_user_id?: string | null;
  created_by_display_name?: string | null;
}

export function mapAutomaticSessionFields(
  row: AutomaticSessionRowFields
): Pick<ChatSession, 'origin' | 'automaticInvestigation'> {
  const linked = row.origin === 'auto_triage'
    && row.linked_issue_id
    && row.linked_issue_lifecycle_version != null
    && row.linked_issue_severity
    && row.auto_triage_write_mode
    && row.auto_triage_effective_tool_mode
    && row.auto_triage_confirmation_required != null;
  return {
    origin: row.origin || 'manual',
    automaticInvestigation: linked
      ? {
          issueId: row.linked_issue_id!,
          lifecycleVersion: Number(row.linked_issue_lifecycle_version),
          severity: row.linked_issue_severity!,
          scopeKind: row.linked_issue_scope_kind || undefined,
          scopeName: row.linked_issue_scope_name || undefined,
          objectKind: row.linked_issue_object_kind || undefined,
          objectName: row.linked_issue_object_name || undefined,
          writeMode: row.auto_triage_write_mode!,
          effectiveToolMode: row.auto_triage_effective_tool_mode!,
          confirmationRequiredForWrite: row.auto_triage_confirmation_required!
        }
      : undefined
  };
}

export function mapMessageAuthorFields(
  row: MessageAuthorRowFields
): Pick<Message, 'createdBy' | 'createdByUser'> {
  return {
    createdBy: row.created_by || undefined,
    createdByUser: row.created_by_user_id && row.created_by_display_name
      ? { id: row.created_by_user_id, displayName: row.created_by_display_name }
      : undefined
  };
}
