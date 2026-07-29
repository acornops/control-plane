export const sessionSelect = `
  SELECT s.*, t.target_type, u.id AS created_by_user_id, u.display_name AS created_by_display_name,
         linked_issue.severity AS linked_issue_severity,
         linked_issue.scope_kind AS linked_issue_scope_kind,
         linked_issue.scope_name AS linked_issue_scope_name,
         linked_issue.object_kind AS linked_issue_object_kind,
         linked_issue.object_name AS linked_issue_object_name,
         latest_run.llm_provider AS last_llm_provider,
         latest_run.llm_model AS last_llm_model,
         latest_run.llm_reasoning_effort AS last_llm_reasoning_effort
  FROM sessions s
  JOIN targets t ON t.id = s.target_id
  LEFT JOIN users u ON u.id = s.created_by
  LEFT JOIN target_issues linked_issue ON linked_issue.id = s.linked_issue_id
  LEFT JOIN LATERAL (
    SELECT r.llm_provider, r.llm_model, r.llm_reasoning_effort
    FROM runs r
    WHERE r.session_id = s.id
    ORDER BY r.requested_at DESC, r.id DESC
    LIMIT 1
  ) latest_run ON TRUE
`;
