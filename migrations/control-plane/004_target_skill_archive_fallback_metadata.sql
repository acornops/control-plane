ALTER TABLE target_skills
  DROP CONSTRAINT IF EXISTS target_skills_source_metadata_check;

ALTER TABLE target_skills
  ADD CONSTRAINT target_skills_source_metadata_check CHECK (
    (source_type = 'manual'
      AND source_repo_url IS NULL
      AND source_ref IS NULL
      AND source_subpath IS NULL
      AND source_commit_sha IS NULL
      AND sync_status = 'not_applicable')
    OR
    (source_type = 'git_import'
      AND source_repo_url IS NOT NULL
      AND source_ref IS NOT NULL
      AND sync_status IN ('current', 'modified'))
  );
