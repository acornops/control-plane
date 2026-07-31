ALTER TABLE target_auto_triage_settings
  ADD COLUMN namespace_include jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN namespace_exclude jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN include_cluster_scoped_issues boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT target_auto_triage_settings_namespace_include_check
    CHECK (
      jsonb_typeof(namespace_include) = 'array'
      AND jsonb_array_length(namespace_include) <= 100
      AND jsonb_path_query_array(
        namespace_include,
        '$[*] ? (@.type() == "string" && @ like_regex "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")'
      ) = namespace_include
    ),
  ADD CONSTRAINT target_auto_triage_settings_namespace_exclude_check
    CHECK (
      jsonb_typeof(namespace_exclude) = 'array'
      AND jsonb_array_length(namespace_exclude) <= 100
      AND jsonb_path_query_array(
        namespace_exclude,
        '$[*] ? (@.type() == "string" && @ like_regex "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")'
      ) = namespace_exclude
    );
