import type { ApprovalDisplayContext } from '../types/approvals.js';

export interface ApprovalDisplayContextRow {
  workspace_name?: string | null;
  target_name?: string | null;
  requested_by_user_id?: string | null;
  requested_by_display_name?: string | null;
  decided_by_user_id?: string | null;
  decided_by_display_name?: string | null;
}

// The caller scopes approval alias a before returning rows. Join only the
// persisted actor references, including historical actors without membership.
export const APPROVAL_DISPLAY_COLUMNS = `
  display_workspace.name AS workspace_name,
  requested_user.id AS requested_by_user_id,
  requested_user.display_name AS requested_by_display_name,
  decided_user.id AS decided_by_user_id,
  decided_user.display_name AS decided_by_display_name`;

export const APPROVAL_DISPLAY_JOINS = `
  LEFT JOIN workspaces display_workspace ON display_workspace.id = a.workspace_id
  LEFT JOIN users requested_user ON requested_user.id = a.requested_by
  LEFT JOIN users decided_user ON decided_user.id = a.decided_by`;

export function mapApprovalDisplayContext(row: ApprovalDisplayContextRow): ApprovalDisplayContext {
  return {
    ...(row.workspace_name ? { workspaceName: row.workspace_name } : {}),
    ...(row.target_name ? { targetName: row.target_name } : {}),
    ...(row.requested_by_user_id && row.requested_by_display_name ? {
      requestedByUser: { id: row.requested_by_user_id, displayName: row.requested_by_display_name }
    } : {}),
    ...(row.decided_by_user_id && row.decided_by_display_name ? {
      decidedByUser: { id: row.decided_by_user_id, displayName: row.decided_by_display_name }
    } : {})
  };
}
