CREATE TABLE workspace_member_mcp_lifecycle (
    workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    membership_generation bigint NOT NULL,
    status text NOT NULL,
    reconciliation_status text DEFAULT 'pending'::text NOT NULL,
    blocks_readiness boolean DEFAULT false NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_member_mcp_lifecycle_pkey PRIMARY KEY (workspace_id, user_id),
    CONSTRAINT workspace_member_mcp_lifecycle_generation_check CHECK (membership_generation BETWEEN 1 AND 9007199254740991),
    CONSTRAINT workspace_member_mcp_lifecycle_status_check CHECK (status = ANY (ARRAY['active'::text, 'removed'::text])),
    CONSTRAINT workspace_member_mcp_lifecycle_reconciliation_status_check CHECK (reconciliation_status = ANY (ARRAY['pending'::text, 'processing'::text, 'failed'::text, 'synced'::text])),
    CONSTRAINT workspace_member_mcp_lifecycle_attempt_count_check CHECK (attempt_count >= 0),
    CONSTRAINT workspace_member_mcp_lifecycle_last_error_code_check CHECK ((last_error_code IS NULL) OR (length(last_error_code) <= 64))
);

CREATE INDEX idx_workspace_member_mcp_lifecycle_due
    ON workspace_member_mcp_lifecycle (reconciliation_status, next_attempt_at, lease_expires_at);

CREATE INDEX idx_workspace_member_mcp_lifecycle_readiness_blockers
    ON workspace_member_mcp_lifecycle (workspace_id)
    WHERE blocks_readiness=true AND reconciliation_status<>'synced';

CREATE FUNCTION advance_workspace_member_mcp_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    next_status text;
    target_workspace_id text;
    target_user_id text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        next_status := 'active';
        target_workspace_id := NEW.workspace_id;
        target_user_id := NEW.user_id;
    ELSE
        next_status := 'removed';
        target_workspace_id := OLD.workspace_id;
        target_user_id := OLD.user_id;
        -- Workspace-wide teardown owns cascaded workspace deletion. Avoid
        -- recreating a child row whose parent is being removed (and likewise
        -- avoid an impossible user-owned tombstone during user deletion).
        IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id=target_workspace_id)
           OR NOT EXISTS (SELECT 1 FROM users WHERE id=target_user_id) THEN
            RETURN OLD;
        END IF;
    END IF;

    INSERT INTO workspace_member_mcp_lifecycle (
        workspace_id,
        user_id,
        membership_generation,
        status,
        reconciliation_status,
        blocks_readiness,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        last_error_code
    )
    VALUES (
        target_workspace_id,
        target_user_id,
        1,
        next_status,
        'pending',
        false,
        0,
        NOW(),
        NULL,
        NULL,
        NULL
    )
    ON CONFLICT (workspace_id, user_id) DO UPDATE
    SET membership_generation=workspace_member_mcp_lifecycle.membership_generation+1,
        status=EXCLUDED.status,
        reconciliation_status='pending',
        -- Only the one-time migration backfill gates global readiness. Preserve
        -- that gate until it is reconciled; ordinary membership transitions
        -- remain principal-scoped and do not drain every control-plane pod.
        blocks_readiness=workspace_member_mcp_lifecycle.blocks_readiness,
        attempt_count=0,
        next_attempt_at=NOW(),
        lease_owner=NULL,
        lease_expires_at=NULL,
        last_error_code=NULL,
        updated_at=NOW();

    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER workspace_memberships_mcp_lifecycle_transition
    AFTER INSERT OR DELETE ON workspace_memberships
    FOR EACH ROW EXECUTE FUNCTION advance_workspace_member_mcp_lifecycle();

INSERT INTO workspace_member_mcp_lifecycle (
    workspace_id,
    user_id,
    membership_generation,
    status,
    reconciliation_status,
    blocks_readiness
)
SELECT
    membership.workspace_id,
    membership.user_id,
    1,
    'active',
    'pending',
    true
FROM workspace_memberships membership
INNER JOIN workspaces workspace ON workspace.id=membership.workspace_id
INNER JOIN users target_user ON target_user.id=membership.user_id
ON CONFLICT (workspace_id, user_id) DO NOTHING;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM mcp_secret_cleanup_jobs LIMIT 1) THEN
        RAISE EXCEPTION USING
            MESSAGE = '006_mcp_user_lifecycle requires mcp_secret_cleanup_jobs to be empty',
            HINT = 'Stop old control-plane and gateway replicas, drain the legacy cleanup worker to zero, then retry the pinned maintenance migration.';
    END IF;
END;
$$;

DROP TABLE mcp_secret_cleanup_jobs;

CREATE TABLE mcp_oauth_state_correlations (
    state_hash text NOT NULL,
    workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id text NOT NULL,
    return_path text NOT NULL,
    membership_generation bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_oauth_state_correlations_pkey PRIMARY KEY (state_hash),
    CONSTRAINT mcp_oauth_state_correlations_generation_check CHECK (membership_generation BETWEEN 1 AND 9007199254740991),
    CONSTRAINT mcp_oauth_state_correlations_state_hash_check CHECK (length(state_hash) = 64),
    CONSTRAINT mcp_oauth_state_correlations_server_id_check CHECK (length(server_id) BETWEEN 1 AND 128),
    CONSTRAINT mcp_oauth_state_correlations_return_path_check CHECK (length(return_path) BETWEEN 1 AND 2048),
    CONSTRAINT mcp_oauth_state_correlations_membership_fkey
        FOREIGN KEY (workspace_id,user_id)
        REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE CASCADE
);

CREATE INDEX idx_mcp_oauth_state_correlations_expires_at
    ON mcp_oauth_state_correlations (expires_at);

CREATE TABLE mcp_oauth_preparation_correlations (
    preparation_handle_hash text NOT NULL,
    workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id text NOT NULL,
    return_path text NOT NULL,
    membership_generation bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_oauth_preparation_correlations_pkey PRIMARY KEY (preparation_handle_hash),
    CONSTRAINT mcp_oauth_preparation_correlations_generation_check CHECK (membership_generation BETWEEN 1 AND 9007199254740991),
    CONSTRAINT mcp_oauth_preparation_correlations_handle_hash_check CHECK (length(preparation_handle_hash) = 64),
    CONSTRAINT mcp_oauth_preparation_correlations_server_id_check CHECK (length(server_id) BETWEEN 1 AND 128),
    CONSTRAINT mcp_oauth_preparation_correlations_return_path_check CHECK (length(return_path) BETWEEN 1 AND 2048),
    CONSTRAINT mcp_oauth_preparation_correlations_membership_fkey
        FOREIGN KEY (workspace_id,user_id)
        REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE CASCADE
);

CREATE INDEX idx_mcp_oauth_preparation_correlations_expires_at
    ON mcp_oauth_preparation_correlations (expires_at);
