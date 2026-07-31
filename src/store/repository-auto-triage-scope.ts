export const AUTO_TRIAGE_SCOPE_SQL = (
  issueAlias: string,
  settingsAlias: string
): string => `(
  ${issueAlias}.target_type <> 'kubernetes'
  OR (
    LOWER(COALESCE(${issueAlias}.scope_kind, '')) = 'namespace'
    AND NULLIF(BTRIM(${issueAlias}.scope_name), '') IS NOT NULL
    AND NOT (${settingsAlias}.namespace_exclude ? BTRIM(${issueAlias}.scope_name))
    AND (
      jsonb_array_length(${settingsAlias}.namespace_include) = 0
      OR ${settingsAlias}.namespace_include ? BTRIM(${issueAlias}.scope_name)
    )
  )
  OR (
    (
      LOWER(COALESCE(${issueAlias}.scope_kind, '')) <> 'namespace'
      OR NULLIF(BTRIM(${issueAlias}.scope_name), '') IS NULL
    )
    AND ${settingsAlias}.include_cluster_scoped_issues = TRUE
  )
)`;
