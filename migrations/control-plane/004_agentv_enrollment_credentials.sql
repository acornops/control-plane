CREATE TABLE agentv_enrollments (
    id text PRIMARY KEY,
    target_id text NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    purpose text NOT NULL CHECK (purpose IN ('initial', 'replace')),
    token_hash text NOT NULL,
    transaction_secret_hash text,
    status text NOT NULL CHECK (status IN ('issued', 'exchanged', 'verified', 'completed', 'cancelled', 'expired')),
    created_by text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    transaction_expires_at timestamp with time zone,
    exchanged_at timestamp with time zone,
    verified_at timestamp with time zone,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    expired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE agentv_enrollments
    ADD CONSTRAINT agentv_enrollments_workspace_target_fkey
    FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE agentv_enrollments
    ADD CONSTRAINT agentv_enrollments_id_target_unique UNIQUE (id, target_id);

CREATE INDEX agentv_enrollments_target_idx ON agentv_enrollments(target_id, created_at DESC);
CREATE INDEX agentv_enrollments_expiry_idx ON agentv_enrollments(status, expires_at);
CREATE INDEX agentv_enrollments_transaction_expiry_idx ON agentv_enrollments(status, transaction_expires_at);

CREATE TABLE agentv_credentials (
    id text PRIMARY KEY,
    target_id text NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    enrollment_id text NOT NULL REFERENCES agentv_enrollments(id) ON DELETE CASCADE,
    key_hash text NOT NULL,
    generation integer NOT NULL CHECK (generation > 0),
    state text NOT NULL CHECK (state IN ('pending', 'active', 'grace', 'revoked')),
    grace_expires_at timestamp with time zone,
    replacement_enrollment_id text REFERENCES agentv_enrollments(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    activated_at timestamp with time zone,
    revoked_at timestamp with time zone
);

ALTER TABLE agentv_credentials
    ADD CONSTRAINT agentv_credentials_enrollment_target_fkey
    FOREIGN KEY (enrollment_id, target_id) REFERENCES agentv_enrollments(id, target_id) ON DELETE CASCADE;

CREATE UNIQUE INDEX agentv_credentials_generation_idx ON agentv_credentials(target_id, generation);
CREATE UNIQUE INDEX agentv_credentials_enrollment_idx ON agentv_credentials(enrollment_id);
CREATE UNIQUE INDEX agentv_credentials_one_active_idx ON agentv_credentials(target_id) WHERE state = 'active';
CREATE UNIQUE INDEX agentv_credentials_one_pending_idx ON agentv_credentials(target_id) WHERE state = 'pending';
CREATE UNIQUE INDEX agentv_credentials_one_grace_idx ON agentv_credentials(target_id) WHERE state = 'grace';
CREATE INDEX agentv_credentials_auth_idx ON agentv_credentials(target_id, state);

ALTER TABLE target_agent_registrations
    ADD COLUMN last_authenticated_key_version integer
    CHECK (last_authenticated_key_version IS NULL OR last_authenticated_key_version > 0);
