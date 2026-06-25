ALTER TABLE target_skill_files
  DROP CONSTRAINT IF EXISTS target_skill_files_path_check;

ALTER TABLE target_skill_files
  ADD CONSTRAINT target_skill_files_path_check CHECK (
    path = 'SKILL.md'
    OR (
      path LIKE '%.md'
      AND path NOT LIKE '/%'
      AND path NOT LIKE '%/'
      AND path NOT LIKE '%//%'
      AND path NOT LIKE '../%'
      AND path NOT LIKE '%/../%'
      AND path NOT LIKE './%'
      AND path NOT LIKE '%/./%'
    )
  );
