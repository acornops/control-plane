ALTER TABLE agent_definitions
  ADD COLUMN avatar_emoji TEXT NOT NULL DEFAULT '🤖';

ALTER TABLE agent_definitions
  ADD CONSTRAINT agent_definitions_avatar_emoji_check
  CHECK (char_length(avatar_emoji) BETWEEN 1 AND 64);

UPDATE agent_definitions
SET avatar_emoji = CASE
  WHEN name = 'Target Diagnostics' THEN '🔎'
  WHEN name = 'Target Remediation' THEN '🛠️'
  WHEN name = 'Incident Reporter' THEN '📝'
  ELSE avatar_emoji
END;
