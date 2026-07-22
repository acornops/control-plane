-- Complete greenfield control-plane schema, derived from the final migrated schema.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE TABLE account_audit_events (
    id text NOT NULL,
    user_id text,
    category text NOT NULL,
    event_type text NOT NULL,
    operation text NOT NULL,
    actor_type text NOT NULL,
    actor_user_id text,
    actor_token_id text,
    object_type text NOT NULL,
    object_id text,
    object_name text,
    summary text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_audit_events_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'system'::text, 'external_integration'::text]))),
    CONSTRAINT account_audit_events_metadata_object_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT account_audit_events_operation_check CHECK ((operation = ANY (ARRAY['read'::text, 'write'::text]))),
    CONSTRAINT account_audit_events_user_actor_check CHECK ((((actor_type = 'user'::text) AND (actor_user_id IS NOT NULL) AND (actor_token_id IS NULL)) OR ((actor_type = 'external_integration'::text) AND (actor_token_id IS NOT NULL)) OR (actor_type = 'system'::text)))
);

CREATE TABLE admin_audit_events (
    id text NOT NULL,
    admin_token_id text,
    action text NOT NULL,
    outcome text NOT NULL,
    workspace_id text,
    target_type text,
    target_id text,
    subject_type text,
    subject_id text,
    reason text,
    request_id text NOT NULL,
    source_ip_hash text,
    user_agent text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_audit_events_metadata_object_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT admin_audit_events_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'failure'::text])))
);

CREATE TABLE agent_activity (
    workspace_id text NOT NULL,
    agent_id text NOT NULL,
    id text NOT NULL,
    agent_version integer NOT NULL,
    trigger_id text,
    status text NOT NULL,
    triggered_by jsonb NOT NULL,
    input_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    compiled_scope jsonb NOT NULL,
    tool_calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    output_artifacts jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    client_request_id text,
    target_id text,
    target_type text,
    idempotency_key text,
    agent_snapshot jsonb,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    error_code text,
    error_message text,
    assistant_message jsonb,
    usage jsonb,
    CONSTRAINT agent_activity_agent_version_check CHECK ((agent_version > 0)),
    CONSTRAINT agent_activity_compiled_scope_check CHECK ((jsonb_typeof(compiled_scope) = 'object'::text)),
    CONSTRAINT agent_activity_input_context_check CHECK ((jsonb_typeof(input_context) = 'object'::text)),
    CONSTRAINT agent_activity_output_artifacts_check CHECK ((jsonb_typeof(output_artifacts) = 'array'::text)),
    CONSTRAINT agent_activity_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting_for_approval'::text, 'needs_review'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT agent_activity_tool_calls_check CHECK ((jsonb_typeof(tool_calls) = 'array'::text)),
    CONSTRAINT agent_activity_triggered_by_check CHECK ((jsonb_typeof(triggered_by) = 'object'::text))
);

CREATE TABLE agent_definitions (
    workspace_id text NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    description text,
    instructions text NOT NULL,
    status text NOT NULL,
    kind text NOT NULL,
    provider_type text NOT NULL,
    version integer NOT NULL,
    owner_user_id text NOT NULL,
    created_by text NOT NULL,
    mcp_servers jsonb DEFAULT '[]'::jsonb NOT NULL,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    skills jsonb DEFAULT '[]'::jsonb NOT NULL,
    context_grants jsonb DEFAULT '[]'::jsonb NOT NULL,
    target_scope jsonb NOT NULL,
    approval_policy jsonb NOT NULL,
    trust_policy jsonb NOT NULL,
    run_count integer DEFAULT 0 NOT NULL,
    last_run_at timestamp with time zone,
    last_status text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    readiness_status text DEFAULT 'needs_setup'::text NOT NULL,
    readiness_reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    mcp_tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    mcp_installations jsonb DEFAULT '[]'::jsonb NOT NULL,
    permission_mode text DEFAULT 'ask_before_changes'::text NOT NULL,
    delegate_agent_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    skill_installations jsonb DEFAULT '[]'::jsonb NOT NULL,
    origin jsonb DEFAULT '{"type": "manual"}'::jsonb NOT NULL,
    review_state text DEFAULT 'reviewed'::text NOT NULL,
    semantic_capability_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    system_role text,
    CONSTRAINT agent_definitions_approval_policy_check CHECK ((jsonb_typeof(approval_policy) = 'object'::text)),
    CONSTRAINT agent_definitions_context_grants_check CHECK ((jsonb_typeof(context_grants) = 'array'::text)),
    CONSTRAINT agent_definitions_delegate_agent_ids_check CHECK ((jsonb_typeof(delegate_agent_ids) = 'array'::text)),
    CONSTRAINT agent_definitions_kind_check CHECK ((kind = ANY (ARRAY['manager'::text, 'specialist'::text]))),
    CONSTRAINT agent_definitions_last_status_check CHECK (((last_status IS NULL) OR (last_status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting_for_approval'::text, 'needs_review'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))),
    CONSTRAINT agent_definitions_manager_coordination_only CHECK (((kind <> 'manager'::text) OR ((mcp_servers = '[]'::jsonb) AND (mcp_tools = '[]'::jsonb) AND (mcp_installations = '[]'::jsonb) AND (tools = '[]'::jsonb) AND (skills = '[]'::jsonb) AND (skill_installations = '[]'::jsonb) AND (context_grants = '[]'::jsonb)))),
    CONSTRAINT agent_definitions_mcp_installations_check CHECK ((jsonb_typeof(mcp_installations) = 'array'::text)),
    CONSTRAINT agent_definitions_mcp_servers_check CHECK ((jsonb_typeof(mcp_servers) = 'array'::text)),
    CONSTRAINT agent_definitions_mcp_tools_check CHECK ((jsonb_typeof(mcp_tools) = 'array'::text)),
    CONSTRAINT agent_definitions_origin_check CHECK (((jsonb_typeof(origin) = 'object'::text) AND ((origin ->> 'type'::text) = ANY (ARRAY['template'::text, 'manual'::text])))),
    CONSTRAINT agent_definitions_permission_mode_check CHECK ((permission_mode = ANY (ARRAY['read_only'::text, 'ask_before_changes'::text, 'auto_allowed_changes'::text]))),
    CONSTRAINT agent_definitions_provider_type_check CHECK ((provider_type = ANY (ARRAY['internal'::text, 'external'::text]))),
    CONSTRAINT agent_definitions_review_state_check CHECK ((review_state = ANY (ARRAY['draft'::text, 'reviewed'::text, 'rejected'::text]))),
    CONSTRAINT agent_definitions_run_count_check CHECK ((run_count >= 0)),
    CONSTRAINT agent_definitions_semantic_capability_ids_check CHECK ((jsonb_typeof(semantic_capability_ids) = 'array'::text)),
    CONSTRAINT agent_definitions_skill_installations_check CHECK ((jsonb_typeof(skill_installations) = 'array'::text)),
    CONSTRAINT agent_definitions_skills_check CHECK ((jsonb_typeof(skills) = 'array'::text)),
    CONSTRAINT agent_definitions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'draft'::text]))),
    CONSTRAINT agent_definitions_system_role_check CHECK (((system_role IS NULL) OR (system_role = 'workflow_coordinator'::text))),
    CONSTRAINT agent_definitions_system_role_kind CHECK (((system_role IS NULL) OR (kind = 'manager'::text))),
    CONSTRAINT agent_definitions_target_scope_check CHECK ((jsonb_typeof(target_scope) = 'object'::text)),
    CONSTRAINT agent_definitions_tools_check CHECK ((jsonb_typeof(tools) = 'array'::text)),
    CONSTRAINT agent_definitions_trust_policy_check CHECK ((jsonb_typeof(trust_policy) = 'object'::text)),
    CONSTRAINT agent_definitions_version_check CHECK ((version > 0))
);

CREATE TABLE agent_run_events (
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    seq integer NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    event_type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_run_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT agent_run_events_seq_check CHECK ((seq > 0))
);

CREATE TABLE agent_skill_files (
    workspace_id text NOT NULL,
    agent_id text NOT NULL,
    skill_id text NOT NULL,
    path text NOT NULL,
    content text NOT NULL,
    content_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE agent_skills (
    workspace_id text NOT NULL,
    agent_id text NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    source_type text NOT NULL,
    source_url text,
    source_ref text,
    source_path text,
    pinned_commit text,
    provenance jsonb,
    content_digest text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_skills_provenance_check CHECK (((provenance IS NULL) OR (jsonb_typeof(provenance) = 'object'::text))),
    CONSTRAINT agent_skills_revision_check CHECK ((revision > 0)),
    CONSTRAINT agent_skills_source_type_check CHECK ((source_type = ANY (ARRAY['manual'::text, 'git'::text, 'template'::text])))
);

CREATE TABLE agent_triggers (
    workspace_id text NOT NULL,
    agent_id text NOT NULL,
    id text NOT NULL,
    type text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    name text,
    schedule jsonb,
    event_filter jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    secret_ciphertext text,
    next_occurrence_at timestamp with time zone,
    principal jsonb,
    CONSTRAINT agent_triggers_event_filter_check CHECK (((event_filter IS NULL) OR (jsonb_typeof(event_filter) = 'object'::text))),
    CONSTRAINT agent_triggers_principal_check CHECK (((principal IS NULL) OR (jsonb_typeof(principal) = 'object'::text))),
    CONSTRAINT agent_triggers_schedule_check CHECK (((schedule IS NULL) OR (jsonb_typeof(schedule) = 'object'::text)))
);

CREATE TABLE agent_versions (
    workspace_id text NOT NULL,
    agent_id text NOT NULL,
    id text NOT NULL,
    version integer NOT NULL,
    snapshot jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_versions_snapshot_check CHECK ((jsonb_typeof(snapshot) = 'object'::text)),
    CONSTRAINT agent_versions_version_check CHECK ((version > 0))
);

CREATE TABLE automation_dispatch_outbox (
    id text NOT NULL,
    workspace_id text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    run_id text NOT NULL,
    idempotency_key text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claim_owner text,
    claim_expires_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_dispatch_outbox_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT automation_dispatch_outbox_source_type_check CHECK ((source_type = ANY (ARRAY['agent'::text, 'workflow'::text, 'target'::text]))),
    CONSTRAINT automation_dispatch_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'delivered'::text, 'failed'::text, 'needs_review'::text, 'cancelled'::text])))
);

CREATE TABLE automation_run_approvals (
    id text NOT NULL,
    workspace_id text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    run_id text NOT NULL,
    target_id text,
    target_type text,
    approval_kind text NOT NULL,
    tool_call_id text NOT NULL,
    tool_name text NOT NULL,
    summary text NOT NULL,
    arguments jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    execution_status text DEFAULT 'not_started'::text NOT NULL,
    execution_started_at timestamp with time zone,
    execution_finished_at timestamp with time zone,
    tool_result jsonb,
    tool_result_is_error boolean,
    requested_by text,
    decided_by text,
    decision text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    server_id text,
    server_tool_name text,
    requested_tool_alias text,
    arguments_digest text,
    CONSTRAINT automation_run_approvals_approval_kind_check CHECK ((approval_kind = ANY (ARRAY['pre_step'::text, 'tool_write'::text]))),
    CONSTRAINT automation_run_approvals_arguments_check CHECK ((jsonb_typeof(arguments) = 'object'::text)),
    CONSTRAINT automation_run_approvals_decision_check CHECK (((decision IS NULL) OR (decision = ANY (ARRAY['approved'::text, 'rejected'::text])))),
    CONSTRAINT automation_run_approvals_exact_tool_binding CHECK (((approval_kind <> 'tool_write'::text) OR ((server_id IS NOT NULL) AND (server_tool_name IS NOT NULL) AND (requested_tool_alias IS NOT NULL) AND (arguments_digest ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT automation_run_approvals_execution_status_check CHECK ((execution_status = ANY (ARRAY['not_started'::text, 'executing'::text, 'succeeded'::text, 'failed'::text, 'unknown'::text]))),
    CONSTRAINT automation_run_approvals_source_type_check CHECK ((source_type = ANY (ARRAY['agent'::text, 'workflow'::text]))),
    CONSTRAINT automation_run_approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text])))
);

CREATE TABLE automation_run_continuations (
    source_type text NOT NULL,
    run_id text NOT NULL,
    approval_id text NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_run_continuations_source_type_check CHECK ((source_type = ANY (ARRAY['agent'::text, 'workflow'::text]))),
    CONSTRAINT automation_run_continuations_state_check CHECK ((jsonb_typeof(state) = 'object'::text))
);

CREATE TABLE automation_template_installations (
    workspace_id text NOT NULL,
    template_id text NOT NULL,
    template_version integer NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    installed_by text NOT NULL,
    record_ids jsonb DEFAULT '{}'::jsonb NOT NULL,
    installed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_template_installations_record_ids_check CHECK ((jsonb_typeof(record_ids) = 'object'::text)),
    CONSTRAINT automation_template_installations_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'complete'::text]))),
    CONSTRAINT automation_template_installations_template_version_check CHECK ((template_version > 0))
);

CREATE TABLE automation_trigger_deliveries (
    id text NOT NULL,
    event_id text NOT NULL,
    workspace_id text NOT NULL,
    trigger_id text NOT NULL,
    status text NOT NULL,
    rejection_code text,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claim_owner text,
    claim_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_trigger_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'delivered'::text, 'rejected'::text, 'failed'::text])))
);

CREATE TABLE automation_trigger_events (
    id text NOT NULL,
    workspace_id text NOT NULL,
    event_type text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    occurrence_key text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_trigger_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text))
);

CREATE TABLE capability_routing_mappings (
    workspace_id text NOT NULL,
    id text NOT NULL,
    capability_id text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    agent_id text NOT NULL,
    agent_version integer NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    review_state text DEFAULT 'draft'::text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    target_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    target_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    mcp_tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    native_tool_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    skill_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    context_grants jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by text NOT NULL,
    reviewed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    invocation_scopes jsonb DEFAULT '["agent", "workflow"]'::jsonb NOT NULL,
    target_tool_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT capability_routing_mappings_agent_version_check CHECK ((agent_version > 0)),
    CONSTRAINT capability_routing_mappings_context_grants_check CHECK ((jsonb_typeof(context_grants) = 'array'::text)),
    CONSTRAINT capability_routing_mappings_invocation_scopes_check CHECK (((jsonb_typeof(invocation_scopes) = 'array'::text) AND (invocation_scopes <@ '["agent", "workflow", "target_chat"]'::jsonb))),
    CONSTRAINT capability_routing_mappings_mcp_tools_check CHECK ((jsonb_typeof(mcp_tools) = 'array'::text)),
    CONSTRAINT capability_routing_mappings_native_tool_ids_check CHECK ((jsonb_typeof(native_tool_ids) = 'array'::text)),
    CONSTRAINT capability_routing_mappings_review_state_check CHECK ((review_state = ANY (ARRAY['draft'::text, 'reviewed'::text, 'rejected'::text]))),
    CONSTRAINT capability_routing_mappings_skill_ids_check CHECK ((jsonb_typeof(skill_ids) = 'array'::text)),
    CONSTRAINT capability_routing_mappings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
    CONSTRAINT capability_routing_mappings_target_ids_check CHECK ((jsonb_typeof(target_ids) = 'array'::text)),
    CONSTRAINT capability_routing_mappings_target_tool_refs_check CHECK ((jsonb_typeof(target_tool_refs) = 'array'::text)),
    CONSTRAINT capability_routing_mappings_target_types_check CHECK ((jsonb_typeof(target_types) = 'array'::text)),
    CONSTRAINT capability_routing_mappings_version_check CHECK ((version > 0))
);

CREATE TABLE chat_activity_events (
    id bigint NOT NULL,
    workspace_id text NOT NULL,
    target_id text NOT NULL,
    target_type text NOT NULL,
    session_id text NOT NULL,
    run_id text,
    message_id text,
    approval_id text,
    type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_activity_events_target_type_check CHECK ((target_type = ANY (ARRAY['kubernetes'::text, 'virtual_machine'::text]))),
    CONSTRAINT chat_activity_events_type_check CHECK ((type = ANY (ARRAY['message.created'::text, 'run.created'::text, 'run.status_changed'::text, 'assistant_message.committed'::text, 'approval.requested'::text, 'approval.decided'::text, 'approval.expired'::text, 'session.deleted'::text])))
);

CREATE SEQUENCE chat_activity_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE chat_activity_events_id_seq OWNED BY chat_activity_events.id;

CREATE TABLE external_integration_link_tokens (
    id text NOT NULL,
    token_hash text NOT NULL,
    integration_client_id text NOT NULL,
    provider text NOT NULL,
    client_display_name text NOT NULL,
    external_user_id text NOT NULL,
    external_display_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    invalidated_at timestamp with time zone
);

CREATE TABLE external_integration_user_links (
    id text NOT NULL,
    integration_client_id text NOT NULL,
    provider text NOT NULL,
    client_display_name text NOT NULL,
    external_user_id text NOT NULL,
    external_display_name text,
    acornops_user_id text NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    last_authenticated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);

CREATE TABLE external_integration_workspace_grants (
    id text NOT NULL,
    external_integration_user_link_id text NOT NULL,
    workspace_id text NOT NULL,
    capabilities text[] DEFAULT '{}'::text[] NOT NULL,
    granted_by_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE kubernetes_target_settings (
    target_id text NOT NULL,
    namespace_include jsonb DEFAULT '[]'::jsonb NOT NULL,
    namespace_exclude jsonb DEFAULT '[]'::jsonb NOT NULL,
    write_confirmation_required_override boolean
);

CREATE TABLE mcp_secret_cleanup_jobs (
    id text NOT NULL,
    workspace_id text NOT NULL,
    user_id text,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_secret_cleanup_jobs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT mcp_secret_cleanup_jobs_last_error_code_check CHECK (((last_error_code IS NULL) OR (length(last_error_code) <= 64))),
    CONSTRAINT mcp_secret_cleanup_jobs_reason_check CHECK ((reason = ANY (ARRAY['member_removal'::text, 'workspace_delete'::text]))),
    CONSTRAINT mcp_secret_cleanup_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'failed'::text])))
);

CREATE TABLE messages (
    id text NOT NULL,
    session_id text NOT NULL,
    run_id text,
    role text NOT NULL,
    kind text DEFAULT 'user'::text NOT NULL,
    content text NOT NULL,
    metadata jsonb,
    client_message_id text,
    created_at timestamp with time zone NOT NULL
);

CREATE TABLE role_templates (
    key text NOT NULL,
    display_name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    kind text NOT NULL,
    capabilities jsonb NOT NULL,
    protected boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 1000 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_templates_kind_check CHECK ((kind = ANY (ARRAY['system'::text, 'custom'::text])))
);

CREATE TABLE run_continuations (
    run_id text NOT NULL,
    approval_id text NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE run_events (
    run_id text NOT NULL,
    seq integer NOT NULL,
    ts timestamp with time zone NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL
);

CREATE TABLE run_skill_catalog_snapshots (
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    target_id text NOT NULL,
    target_type text NOT NULL,
    skill_count integer NOT NULL,
    total_bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_skill_catalog_snapshots_skill_count_check CHECK ((skill_count >= 0)),
    CONSTRAINT run_skill_catalog_snapshots_target_type_check CHECK ((target_type = ANY (ARRAY['kubernetes'::text, 'virtual_machine'::text]))),
    CONSTRAINT run_skill_catalog_snapshots_total_bytes_check CHECK ((total_bytes >= 0))
);

CREATE TABLE run_skill_snapshots (
    run_id text NOT NULL,
    skill_ref text NOT NULL,
    skill_id text NOT NULL,
    content_hash text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    source jsonb DEFAULT '{}'::jsonb NOT NULL,
    file_count integer NOT NULL,
    total_bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_skill_snapshots_file_count_check CHECK ((file_count >= 0)),
    CONSTRAINT run_skill_snapshots_total_bytes_check CHECK ((total_bytes >= 0))
);

CREATE TABLE run_tool_approvals (
    id text NOT NULL,
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    target_id text NOT NULL,
    tool_call_id text NOT NULL,
    tool_name text NOT NULL,
    arguments jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    execution_status text DEFAULT 'not_started'::text NOT NULL,
    execution_started_at timestamp with time zone,
    execution_finished_at timestamp with time zone,
    tool_result jsonb,
    tool_result_is_error boolean,
    requested_by text,
    decided_by text,
    decision text,
    summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    server_id text NOT NULL,
    server_tool_name text NOT NULL,
    requested_tool_alias text NOT NULL,
    arguments_digest text NOT NULL,
    CONSTRAINT run_tool_approvals_arguments_digest_format CHECK ((arguments_digest ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE run_tool_result_artifacts (
    id text NOT NULL,
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    call_id text NOT NULL,
    tool_name text NOT NULL,
    sha256 text NOT NULL,
    content_type text NOT NULL,
    encoding text NOT NULL,
    uncompressed_bytes integer NOT NULL,
    compressed_bytes integer NOT NULL,
    payload bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT ck_run_tool_result_artifacts_content_type CHECK ((content_type = ANY (ARRAY['application/json'::text, 'text/plain'::text]))),
    CONSTRAINT ck_run_tool_result_artifacts_encoding CHECK ((encoding = 'gzip'::text)),
    CONSTRAINT ck_run_tool_result_artifacts_expiry CHECK ((expires_at > created_at)),
    CONSTRAINT ck_run_tool_result_artifacts_identity CHECK ((((length(call_id) >= 1) AND (length(call_id) <= 256)) AND ((length(tool_name) >= 1) AND (length(tool_name) <= 128)))),
    CONSTRAINT ck_run_tool_result_artifacts_sha256 CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ck_run_tool_result_artifacts_sizes CHECK (((uncompressed_bytes >= 0) AND (uncompressed_bytes <= 2097152) AND (compressed_bytes > 0)))
);

CREATE TABLE runs (
    id text NOT NULL,
    workspace_id text NOT NULL,
    target_id text NOT NULL,
    session_id text NOT NULL,
    message_id text NOT NULL,
    llm_provider text DEFAULT 'openai'::text NOT NULL,
    llm_model text DEFAULT 'gpt-5.5'::text NOT NULL,
    llm_reasoning_summary_mode text DEFAULT 'auto'::text NOT NULL,
    llm_reasoning_effort text DEFAULT 'low'::text NOT NULL,
    tool_access_mode text DEFAULT 'read_only'::text NOT NULL,
    status text NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    error_code text,
    error_message text,
    usage jsonb,
    assistant_message jsonb,
    assistant_references jsonb DEFAULT '[]'::jsonb NOT NULL,
    principal jsonb,
    request_actor_type text DEFAULT 'user'::text NOT NULL,
    request_external_integration_link_id text,
    request_external_integration_client_id text,
    CONSTRAINT runs_assistant_references_array CHECK ((jsonb_typeof(assistant_references) = 'array'::text)),
    CONSTRAINT runs_llm_provider_check CHECK ((llm_provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'gemini'::text]))),
    CONSTRAINT runs_llm_reasoning_effort_check CHECK ((llm_reasoning_effort = ANY (ARRAY['off'::text, 'low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT runs_llm_reasoning_summary_mode_check CHECK ((llm_reasoning_summary_mode = ANY (ARRAY['off'::text, 'auto'::text, 'concise'::text, 'detailed'::text]))),
    CONSTRAINT runs_principal_check CHECK (((principal IS NULL) OR ((jsonb_typeof(principal) = 'object'::text) AND ((principal ->> 'type'::text) = ANY (ARRAY['user'::text, 'service_identity'::text])) AND (COALESCE((principal ->> 'id'::text), ''::text) <> ''::text)))),
    CONSTRAINT runs_request_actor_type_check CHECK ((request_actor_type = ANY (ARRAY['user'::text, 'external_integration'::text]))),
    CONSTRAINT runs_request_actor_provenance_check CHECK ((((request_actor_type = 'user'::text) AND (request_external_integration_link_id IS NULL) AND (request_external_integration_client_id IS NULL)) OR ((request_actor_type = 'external_integration'::text) AND (request_external_integration_link_id IS NOT NULL) AND (request_external_integration_client_id IS NOT NULL))))
);

CREATE TABLE service_identities (
    workspace_id text NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    role text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_identities_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);

CREATE TABLE sessions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    target_id text NOT NULL,
    created_by text NOT NULL,
    title text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    last_message_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    deleted_at timestamp with time zone
);

CREATE TABLE skill_snapshot_blobs (
    content_hash text NOT NULL,
    files jsonb NOT NULL,
    file_count integer NOT NULL,
    total_bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_referenced_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT skill_snapshot_blobs_file_count_check CHECK ((file_count >= 0)),
    CONSTRAINT skill_snapshot_blobs_total_bytes_check CHECK ((total_bytes >= 0))
);

CREATE TABLE target_agent_registrations (
    target_id text NOT NULL,
    workspace_id text NOT NULL,
    agent_key_hash text NOT NULL,
    key_version integer NOT NULL,
    last_seen_at timestamp with time zone,
    last_heartbeat_at timestamp with time zone,
    last_connection_id text,
    last_agent_version text,
    capabilities jsonb
);

CREATE TABLE target_findings (
    target_id text NOT NULL,
    workspace_id text NOT NULL,
    snapshot_ts timestamp with time zone NOT NULL,
    finding_id text NOT NULL,
    severity text NOT NULL,
    severity_rank integer NOT NULL,
    scope_kind text,
    scope_name text,
    object_kind text,
    object_name text,
    title text NOT NULL,
    message text NOT NULL,
    reason text,
    finding_ts timestamp with time zone NOT NULL,
    search_text text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT target_findings_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])))
);

CREATE TABLE target_insights_checkpoint_jobs (
    workspace_id text NOT NULL,
    target_id text NOT NULL,
    session_id text NOT NULL,
    target_type text NOT NULL,
    last_activity_at timestamp with time zone NOT NULL,
    due_at timestamp with time zone,
    status text DEFAULT 'queued'::text NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    last_error text,
    retry_after timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT target_insights_checkpoint_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT target_insights_checkpoint_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'processing'::text, 'applied'::text, 'noop'::text, 'skipped'::text, 'failed'::text]))),
    CONSTRAINT target_insights_checkpoint_jobs_target_type_check CHECK ((target_type = ANY (ARRAY['kubernetes'::text, 'virtual_machine'::text])))
);

CREATE TABLE target_insights_entries (
    id text NOT NULL,
    workspace_id text NOT NULL,
    target_id text NOT NULL,
    target_type text NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    body_markdown text NOT NULL,
    frontmatter jsonb DEFAULT '{}'::jsonb NOT NULL,
    tags text[] DEFAULT ARRAY[]::text[] NOT NULL,
    signals jsonb DEFAULT '{}'::jsonb NOT NULL,
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    evidence_summary text DEFAULT ''::text NOT NULL,
    observation_count integer DEFAULT 0 NOT NULL,
    confidence numeric(4,3) DEFAULT 0 NOT NULL,
    first_observed_at timestamp with time zone,
    last_observed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT target_insights_entries_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT target_insights_entries_frontmatter_object_check CHECK ((jsonb_typeof(frontmatter) = 'object'::text)),
    CONSTRAINT target_insights_entries_observation_count_check CHECK ((observation_count >= 0)),
    CONSTRAINT target_insights_entries_scope_object_check CHECK ((jsonb_typeof(scope) = 'object'::text)),
    CONSTRAINT target_insights_entries_signals_object_check CHECK ((jsonb_typeof(signals) = 'object'::text)),
    CONSTRAINT target_insights_entries_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending'::text, 'archived'::text]))),
    CONSTRAINT target_insights_entries_target_type_check CHECK ((target_type = ANY (ARRAY['kubernetes'::text, 'virtual_machine'::text])))
);

CREATE TABLE target_inventory_items (
    target_id text NOT NULL,
    workspace_id text NOT NULL,
    snapshot_ts timestamp with time zone NOT NULL,
    item_id text NOT NULL,
    category text NOT NULL,
    kind text NOT NULL,
    scope_kind text,
    scope_name text,
    name text NOT NULL,
    status text,
    location text,
    needs_attention boolean NOT NULL,
    sort_key text NOT NULL,
    search_text text DEFAULT ''::text NOT NULL,
    item jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE target_issue_observations (
    id text NOT NULL,
    issue_id text NOT NULL,
    workspace_id text NOT NULL,
    target_id text NOT NULL,
    target_type text NOT NULL,
    snapshot_ts timestamp with time zone NOT NULL,
    finding_id text,
    severity text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    reason text,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT target_issue_observations_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]))),
    CONSTRAINT target_issue_observations_target_type_check CHECK ((target_type = ANY (ARRAY['kubernetes'::text, 'virtual_machine'::text])))
);

CREATE TABLE target_issues (
    id text NOT NULL,
    workspace_id text NOT NULL,
    target_id text NOT NULL,
    target_type text NOT NULL,
    fingerprint text NOT NULL,
    issue_type text NOT NULL,
    status text NOT NULL,
    severity text NOT NULL,
    severity_rank integer NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    scope_kind text,
    scope_name text,
    object_kind text,
    object_name text,
    reason text,
    first_seen_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    last_observed_snapshot_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone,
    occurrence_count integer DEFAULT 1 NOT NULL,
    reopened_count integer DEFAULT 0 NOT NULL,
    clean_snapshot_count integer DEFAULT 0 NOT NULL,
    lifecycle_version integer DEFAULT 1 NOT NULL,
    latest_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    search_text text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT target_issues_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]))),
    CONSTRAINT target_issues_status_check CHECK ((status = ANY (ARRAY['active'::text, 'recovering'::text, 'resolved'::text]))),
    CONSTRAINT target_issues_target_type_check CHECK ((target_type = ANY (ARRAY['kubernetes'::text, 'virtual_machine'::text])))
);

CREATE TABLE target_metric_history (
    target_id text NOT NULL,
    workspace_id text NOT NULL,
    target_type text NOT NULL,
    sample_ts timestamp with time zone NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT target_metric_history_target_type_check CHECK ((target_type = ANY (ARRAY['kubernetes'::text, 'virtual_machine'::text])))
);

CREATE TABLE target_skill_files (
    skill_id text NOT NULL,
    path text NOT NULL,
    content text NOT NULL,
    size_bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT target_skill_files_path_check CHECK (((path = 'SKILL.md'::text) OR ((path ~~ '%.md'::text) AND (path !~~ '/%'::text) AND (path !~~ '%/'::text) AND (path !~~ '%//%'::text) AND (path !~~ '../%'::text) AND (path !~~ '%/../%'::text) AND (path !~~ './%'::text) AND (path !~~ '%/./%'::text)))),
    CONSTRAINT target_skill_files_size_bytes_check CHECK (((size_bytes >= 0) AND (size_bytes <= 32768)))
);

CREATE TABLE target_skills (
    id text NOT NULL,
    workspace_id text NOT NULL,
    target_id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    source_type text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    validation_status text NOT NULL,
    validation_errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    file_count integer NOT NULL,
    total_bytes integer NOT NULL,
    source_provider text,
    source_repo_url text,
    source_api_base_url text,
    source_ref text,
    source_subpath text,
    source_commit_sha text,
    sync_status text NOT NULL,
    created_by text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT target_skills_file_count_check CHECK (((file_count >= 1) AND (file_count <= 16))),
    CONSTRAINT target_skills_source_metadata_check CHECK ((((source_type = 'manual'::text) AND (source_provider IS NULL) AND (source_repo_url IS NULL) AND (source_api_base_url IS NULL) AND (source_ref IS NULL) AND (source_subpath IS NULL) AND (source_commit_sha IS NULL) AND (sync_status = 'not_applicable'::text)) OR ((source_type = 'git_import'::text) AND (source_provider IS NOT NULL) AND (source_repo_url IS NOT NULL) AND (source_ref IS NOT NULL) AND (sync_status = ANY (ARRAY['current'::text, 'modified'::text]))))),
    CONSTRAINT target_skills_source_provider_check CHECK (((source_provider IS NULL) OR (source_provider = ANY (ARRAY['github'::text, 'gitlab'::text])))),
    CONSTRAINT target_skills_source_type_check CHECK ((source_type = ANY (ARRAY['manual'::text, 'git_import'::text]))),
    CONSTRAINT target_skills_sync_status_check CHECK ((sync_status = ANY (ARRAY['not_applicable'::text, 'current'::text, 'modified'::text]))),
    CONSTRAINT target_skills_total_bytes_check CHECK (((total_bytes >= 0) AND (total_bytes <= 131072))),
    CONSTRAINT target_skills_validation_status_check CHECK ((validation_status = ANY (ARRAY['valid'::text, 'invalid'::text])))
);

CREATE TABLE target_snapshot_summaries (
    target_id text NOT NULL,
    workspace_id text NOT NULL,
    snapshot_ts timestamp with time zone NOT NULL,
    inventory_count integer NOT NULL,
    finding_count integer NOT NULL,
    critical_finding_count integer NOT NULL,
    summary jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE target_snapshots (
    target_id text NOT NULL,
    workspace_id text NOT NULL,
    snapshot_ts timestamp with time zone NOT NULL,
    data jsonb NOT NULL
);

CREATE TABLE target_tool_overrides (
    target_id text NOT NULL,
    tool_name text NOT NULL,
    enabled boolean NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE target_tool_settings (
    target_id text NOT NULL,
    tool_id text NOT NULL,
    enabled boolean NOT NULL,
    config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE targets (
    id text NOT NULL,
    workspace_id text NOT NULL,
    target_type text NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT targets_status_check CHECK ((status = ANY (ARRAY['online'::text, 'offline'::text, 'degraded'::text, 'unknown'::text]))),
    CONSTRAINT targets_target_type_check CHECK ((target_type = ANY (ARRAY['kubernetes'::text, 'virtual_machine'::text])))
);

CREATE TABLE user_email_verification_tokens (
    id text NOT NULL,
    user_id text NOT NULL,
    email text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_sent_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE user_federated_identities (
    user_id text NOT NULL,
    provider text NOT NULL,
    subject text NOT NULL,
    email_at_link_time text NOT NULL,
    email_verified boolean,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone
);

CREATE TABLE user_password_credentials (
    user_id text NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone
);

CREATE TABLE user_password_reset_tokens (
    id text NOT NULL,
    user_id text NOT NULL,
    email text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_sent_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE users (
    id text NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    email_verified_at timestamp with time zone,
    email_verification_required boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE webhook_history (
    id text NOT NULL,
    subscription_id text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    workspace_id text NOT NULL,
    target_id text,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL,
    response_status integer,
    error text,
    duration_ms integer,
    attempt_number integer DEFAULT 1 NOT NULL,
    will_retry boolean DEFAULT false NOT NULL,
    next_attempt_at timestamp with time zone,
    terminal_reason text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE webhook_outbox_events (
    id text NOT NULL,
    event_type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    workspace_id text NOT NULL,
    target_id text,
    target_type text,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    payload jsonb NOT NULL,
    dedupe_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE webhook_delivery_jobs (
    id text NOT NULL,
    event_id text NOT NULL,
    subscription_id text NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    terminal_reason text,
    snapshot_url text,
    snapshot_secret_ciphertext text,
    snapshot_secret_key_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_delivery_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'retrying'::text, 'paused'::text, 'succeeded'::text, 'failed'::text, 'superseded'::text, 'cancelled'::text])))
);

CREATE TABLE webhook_subscriptions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    target_id text,
    name text NOT NULL,
    url text NOT NULL,
    event_types jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    secret_ciphertext text NOT NULL,
    secret_key_id text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE external_webhook_route_connections (
    external_integration_user_link_id text NOT NULL,
    integration_client_id text NOT NULL,
    provider text NOT NULL,
    external_user_id text NOT NULL,
    delivery_url text NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE workflow_approvals (
    id text NOT NULL,
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    workflow_run_id text NOT NULL,
    workflow_session_id text NOT NULL,
    tool_call_id text NOT NULL,
    tool_name text NOT NULL,
    summary text NOT NULL,
    arguments jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    execution_status text NOT NULL,
    requested_by text,
    decided_by text,
    decision text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT workflow_approvals_arguments_check CHECK ((jsonb_typeof(arguments) = 'object'::text))
);

CREATE TABLE workflow_definitions (
    workspace_id text NOT NULL,
    id text NOT NULL,
    version integer NOT NULL,
    template_id text,
    name text NOT NULL,
    description text,
    status text NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    inputs jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled_mcp_servers jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled_skills jsonb DEFAULT '[]'::jsonb NOT NULL,
    required_permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    starter_prompt text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    readiness_status text DEFAULT 'needs_setup'::text NOT NULL,
    readiness_reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    origin jsonb DEFAULT '{"type": "manual"}'::jsonb NOT NULL,
    prompt text NOT NULL,
    entry_agent_id text NOT NULL,
    capability_policy jsonb NOT NULL,
    delegation_policy jsonb,
    agent_ids jsonb NOT NULL,
    resource_requirements jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT workflow_definitions_agent_ids_check CHECK (((agent_ids IS NULL) OR (jsonb_typeof(agent_ids) = 'array'::text))),
    CONSTRAINT workflow_definitions_agent_ids_nonempty CHECK (((jsonb_array_length(agent_ids) > 0) OR ((status = 'paused'::text) AND (readiness_status = 'blocked'::text) AND (readiness_reasons ? 'WORKFLOW_AGENT_SELECTION_REQUIRED'::text)))),
    CONSTRAINT workflow_definitions_delegation_policy_check CHECK (((delegation_policy IS NULL) OR (jsonb_typeof(delegation_policy) = 'object'::text))),
    CONSTRAINT workflow_definitions_enabled_mcp_servers_check CHECK ((jsonb_typeof(enabled_mcp_servers) = 'array'::text)),
    CONSTRAINT workflow_definitions_enabled_skills_check CHECK ((jsonb_typeof(enabled_skills) = 'array'::text)),
    CONSTRAINT workflow_definitions_inputs_check CHECK ((jsonb_typeof(inputs) = 'array'::text)),
    CONSTRAINT workflow_definitions_origin_check CHECK (((jsonb_typeof(origin) = 'object'::text) AND ((origin ->> 'type'::text) = ANY (ARRAY['template'::text, 'manual'::text])))),
    CONSTRAINT workflow_definitions_required_permissions_check CHECK ((jsonb_typeof(required_permissions) = 'array'::text)),
    CONSTRAINT workflow_definitions_resource_requirements_check CHECK ((jsonb_typeof(resource_requirements) = 'array'::text)),
    CONSTRAINT workflow_definitions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'draft'::text, 'paused'::text]))),
    CONSTRAINT workflow_definitions_tags_check CHECK ((jsonb_typeof(tags) = 'array'::text)),
    CONSTRAINT workflow_definitions_version_check CHECK ((version > 0))
);

CREATE TABLE workflow_delegations (
    id text NOT NULL,
    workspace_id text NOT NULL,
    parent_execution_id text NOT NULL,
    child_run_id text,
    capability_id text NOT NULL,
    target_binding jsonb NOT NULL,
    task_prompt text NOT NULL,
    required boolean DEFAULT true NOT NULL,
    selected_agent_id text NOT NULL,
    selected_agent_version integer NOT NULL,
    compiled_scope jsonb NOT NULL,
    status text NOT NULL,
    result jsonb,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_delegations_compiled_scope_check CHECK ((jsonb_typeof(compiled_scope) = 'object'::text)),
    CONSTRAINT workflow_delegations_selected_agent_version_check CHECK ((selected_agent_version > 0)),
    CONSTRAINT workflow_delegations_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT workflow_delegations_target_binding_check CHECK ((jsonb_typeof(target_binding) = 'object'::text))
);

CREATE TABLE workflow_executions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    workflow_version integer NOT NULL,
    workflow_session_id text NOT NULL,
    message_id text NOT NULL,
    created_by text NOT NULL,
    trigger_type text DEFAULT 'manual'::text NOT NULL,
    trigger_id text,
    occurrence_key text,
    client_request_id text,
    status text NOT NULL,
    workflow_snapshot jsonb NOT NULL,
    approved_context_grants jsonb DEFAULT '[]'::jsonb NOT NULL,
    cancellation_requested_at timestamp with time zone,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    prompt_text text DEFAULT ''::text NOT NULL,
    prompt_digest text DEFAULT ''::text NOT NULL,
    binding_digest text DEFAULT ''::text NOT NULL,
    resource_bindings jsonb DEFAULT '[]'::jsonb NOT NULL,
    resolved_at timestamp with time zone DEFAULT now() NOT NULL,
    request_actor_type text DEFAULT 'user'::text NOT NULL,
    request_external_integration_link_id text,
    request_external_integration_client_id text,
    CONSTRAINT workflow_executions_approved_context_grants_check CHECK ((jsonb_typeof(approved_context_grants) = 'array'::text)),
    CONSTRAINT workflow_executions_resource_bindings_check CHECK ((jsonb_typeof(resource_bindings) = 'array'::text)),
    CONSTRAINT workflow_executions_workflow_snapshot_check CHECK ((jsonb_typeof(workflow_snapshot) = 'object'::text)),
    CONSTRAINT workflow_executions_workflow_version_check CHECK ((workflow_version > 0)),
    CONSTRAINT workflow_executions_request_actor_provenance_check CHECK ((((request_actor_type = 'user'::text) AND (request_external_integration_link_id IS NULL) AND (request_external_integration_client_id IS NULL)) OR ((request_actor_type = 'external_integration'::text) AND (request_external_integration_link_id IS NOT NULL) AND (request_external_integration_client_id IS NOT NULL))))
);

CREATE TABLE workflow_mcp_servers (
    workspace_id text NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    auth_type text NOT NULL,
    public_headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by text NOT NULL,
    last_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_mcp_servers_public_headers_check CHECK ((jsonb_typeof(public_headers) = 'object'::text)),
    CONSTRAINT workflow_mcp_servers_tools_check CHECK ((jsonb_typeof(tools) = 'array'::text))
);

CREATE TABLE workflow_messages (
    id text NOT NULL,
    session_id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    run_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
);

CREATE TABLE workflow_reports (
    id text NOT NULL,
    workspace_id text NOT NULL,
    execution_id text,
    run_id text,
    source_version integer NOT NULL,
    media_type text DEFAULT 'application/pdf'::text NOT NULL,
    title text NOT NULL,
    source jsonb NOT NULL,
    provenance jsonb NOT NULL,
    source_size_bytes integer NOT NULL,
    retention_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tool_call_id text,
    target_run_id text,
    CONSTRAINT workflow_reports_exactly_one_run_scope_check CHECK ((((execution_id IS NOT NULL) AND (run_id IS NOT NULL) AND (target_run_id IS NULL)) OR ((execution_id IS NULL) AND (run_id IS NULL) AND (target_run_id IS NOT NULL)))),
    CONSTRAINT workflow_reports_provenance_check CHECK ((jsonb_typeof(provenance) = 'object'::text)),
    CONSTRAINT workflow_reports_source_check CHECK ((jsonb_typeof(source) = 'object'::text)),
    CONSTRAINT workflow_reports_source_size_bytes_check CHECK ((source_size_bytes >= 0)),
    CONSTRAINT workflow_reports_source_version_check CHECK ((source_version > 0))
);

CREATE TABLE workflow_run_events (
    run_id text NOT NULL,
    seq integer NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    event_type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_run_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT workflow_run_events_seq_check CHECK ((seq > 0))
);

CREATE TABLE workflow_runs (
    id text NOT NULL,
    workflow_run_id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    workflow_session_id text NOT NULL,
    message_id text NOT NULL,
    created_by text NOT NULL,
    status text NOT NULL,
    compiled_access_scope jsonb NOT NULL,
    llm_provider text,
    llm_model text,
    llm_reasoning_summary_mode text,
    llm_reasoning_effort text,
    requested_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    error_code text,
    error_message text,
    assistant_message jsonb,
    usage jsonb,
    events jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    execution_id text NOT NULL,
    attempt_number integer DEFAULT 1 NOT NULL,
    agent_id text,
    agent_version integer,
    agent_snapshot jsonb,
    target_id text,
    target_type text,
    idempotency_key text NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    claim_owner text,
    claim_expires_at timestamp with time zone,
    cancellation_requested_at timestamp with time zone,
    uncertain_write boolean DEFAULT false NOT NULL,
    prompt_text text DEFAULT ''::text NOT NULL,
    prompt_digest text DEFAULT ''::text NOT NULL,
    binding_digest text DEFAULT ''::text NOT NULL,
    resource_bindings jsonb DEFAULT '[]'::jsonb NOT NULL,
    resolved_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_runs_assistant_message_check CHECK (((assistant_message IS NULL) OR (jsonb_typeof(assistant_message) = 'object'::text))),
    CONSTRAINT workflow_runs_compiled_access_scope_check CHECK ((jsonb_typeof(compiled_access_scope) = 'object'::text)),
    CONSTRAINT workflow_runs_events_check CHECK ((jsonb_typeof(events) = 'array'::text)),
    CONSTRAINT workflow_runs_resource_bindings_check CHECK ((jsonb_typeof(resource_bindings) = 'array'::text))
);

CREATE TABLE workflow_execution_events (
    id bigserial PRIMARY KEY,
    execution_id text NOT NULL,
    workspace_id text NOT NULL,
    event_type text NOT NULL,
    run_id text,
    run_event_seq integer,
    approval_id text,
    dedupe_key text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_execution_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT workflow_execution_events_execution_dedupe_key UNIQUE (execution_id, dedupe_key)
);

CREATE TABLE workflow_schedules (
    id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    workflow_version integer NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    cron text NOT NULL,
    timezone text NOT NULL,
    approved_context_grants jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by jsonb NOT NULL,
    updated_by jsonb NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    last_status text,
    last_error text,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    principal jsonb NOT NULL,
    control_message text DEFAULT ''::text NOT NULL,
    CONSTRAINT workflow_schedules_approved_context_grants_check CHECK ((jsonb_typeof(approved_context_grants) = 'array'::text)),
    CONSTRAINT workflow_schedules_created_by_check CHECK ((jsonb_typeof(created_by) = 'object'::text)),
    CONSTRAINT workflow_schedules_principal_check CHECK (((jsonb_typeof(principal) = 'object'::text) AND ((principal ->> 'type'::text) = 'user'::text) AND (COALESCE((principal ->> 'id'::text), ''::text) <> ''::text))),
    CONSTRAINT workflow_schedules_status_check CHECK ((status = ANY (ARRAY['enabled'::text, 'paused'::text]))),
    CONSTRAINT workflow_schedules_updated_by_check CHECK ((jsonb_typeof(updated_by) = 'object'::text)),
    CONSTRAINT workflow_schedules_workflow_version_check CHECK ((workflow_version > 0))
);

CREATE TABLE workflow_sessions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    workflow_version integer NOT NULL,
    created_by text NOT NULL,
    compiled_access_scope jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workflow_snapshot jsonb NOT NULL,
    request_actor_type text DEFAULT 'user'::text NOT NULL,
    request_external_integration_link_id text,
    request_external_integration_client_id text,
    CONSTRAINT workflow_sessions_compiled_access_scope_check CHECK ((jsonb_typeof(compiled_access_scope) = 'object'::text)),
    CONSTRAINT workflow_sessions_workflow_snapshot_check CHECK ((jsonb_typeof(workflow_snapshot) = 'object'::text)),
    CONSTRAINT workflow_sessions_workflow_version_check CHECK ((workflow_version > 0)),
    CONSTRAINT workflow_sessions_request_actor_provenance_check CHECK ((((request_actor_type = 'user'::text) AND (request_external_integration_link_id IS NULL) AND (request_external_integration_client_id IS NULL)) OR ((request_actor_type = 'external_integration'::text) AND (request_external_integration_link_id IS NOT NULL) AND (request_external_integration_client_id IS NOT NULL))))
);

CREATE TABLE workspace_ai_settings (
    workspace_id text NOT NULL,
    default_provider text NOT NULL,
    default_model text NOT NULL,
    reasoning_summary_mode text DEFAULT 'auto'::text NOT NULL,
    reasoning_effort text DEFAULT 'low'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_ai_settings_default_provider_check CHECK ((default_provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'gemini'::text]))),
    CONSTRAINT workspace_ai_settings_reasoning_effort_check CHECK ((reasoning_effort = ANY (ARRAY['off'::text, 'low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT workspace_ai_settings_reasoning_summary_mode_check CHECK ((reasoning_summary_mode = ANY (ARRAY['off'::text, 'auto'::text, 'concise'::text, 'detailed'::text])))
);

CREATE TABLE workspace_audit_events (
    id text NOT NULL,
    workspace_id text NOT NULL,
    category text NOT NULL,
    event_type text NOT NULL,
    operation text NOT NULL,
    actor_type text NOT NULL,
    actor_user_id text,
    actor_token_id text,
    object_type text NOT NULL,
    object_id text,
    object_name text,
    summary text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_audit_events_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'system'::text, 'admin_token'::text]))),
    CONSTRAINT workspace_audit_events_category_check CHECK ((category = ANY (ARRAY['membership'::text, 'workspace'::text, 'target'::text, 'session'::text, 'run'::text, 'approval'::text, 'mcp'::text, 'tool'::text, 'insights'::text]))),
    CONSTRAINT workspace_audit_events_metadata_object_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT workspace_audit_events_operation_check CHECK ((operation = ANY (ARRAY['read'::text, 'write'::text]))),
    CONSTRAINT workspace_audit_events_user_actor_check CHECK ((((actor_type = 'system'::text) AND (actor_user_id IS NULL) AND (actor_token_id IS NULL)) OR ((actor_type = 'user'::text) AND (actor_user_id IS NOT NULL) AND (actor_token_id IS NULL)) OR ((actor_type = 'admin_token'::text) AND (actor_user_id IS NULL) AND (actor_token_id IS NOT NULL))))
);

CREATE TABLE workspace_invitations (
    id text NOT NULL,
    workspace_id text NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    token_hash text NOT NULL,
    invited_by text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    accepted_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT workspace_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text, 'expired'::text])))
);

CREATE TABLE workspace_membership_audit (
    id text NOT NULL,
    workspace_id text NOT NULL,
    target_user_id text NOT NULL,
    actor_user_id text NOT NULL,
    action text NOT NULL,
    previous_role text,
    next_role text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE workspace_memberships (
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    source text DEFAULT 'internal'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE workspace_quota_overrides (
    workspace_id text NOT NULL,
    members integer,
    kubernetes_clusters integer,
    virtual_machines integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_quota_overrides_kubernetes_clusters_check CHECK (((kubernetes_clusters IS NULL) OR (kubernetes_clusters > 0))),
    CONSTRAINT workspace_quota_overrides_members_check CHECK (((members IS NULL) OR (members > 0))),
    CONSTRAINT workspace_quota_overrides_virtual_machines_check CHECK (((virtual_machines IS NULL) OR (virtual_machines > 0)))
);

CREATE TABLE workspace_skills (
    workspace_id text NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    source text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    validation_status text DEFAULT 'valid'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_skills_source_check CHECK ((source = ANY (ARRAY['system'::text, 'workspace'::text]))),
    CONSTRAINT workspace_skills_validation_status_check CHECK ((validation_status = ANY (ARRAY['valid'::text, 'invalid'::text])))
);

CREATE TABLE workspaces (
    id text NOT NULL,
    name text NOT NULL,
    plan_key text DEFAULT 'default'::text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY chat_activity_events ALTER COLUMN id SET DEFAULT nextval('chat_activity_events_id_seq'::regclass);

ALTER TABLE ONLY account_audit_events
    ADD CONSTRAINT account_audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY admin_audit_events
    ADD CONSTRAINT admin_audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY agent_activity
    ADD CONSTRAINT agent_activity_pkey PRIMARY KEY (workspace_id, agent_id, id);

ALTER TABLE ONLY agent_activity
    ADD CONSTRAINT agent_activity_workspace_run_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY agent_definitions
    ADD CONSTRAINT agent_definitions_pkey PRIMARY KEY (workspace_id, id);

ALTER TABLE ONLY agent_run_events
    ADD CONSTRAINT agent_run_events_pkey PRIMARY KEY (run_id, seq);

ALTER TABLE ONLY agent_skill_files
    ADD CONSTRAINT agent_skill_files_pkey PRIMARY KEY (workspace_id, agent_id, skill_id, path);

ALTER TABLE ONLY agent_skills
    ADD CONSTRAINT agent_skills_pkey PRIMARY KEY (workspace_id, agent_id, id);

ALTER TABLE ONLY agent_skills
    ADD CONSTRAINT agent_skills_workspace_id_agent_id_name_key UNIQUE (workspace_id, agent_id, name);

ALTER TABLE ONLY agent_triggers
    ADD CONSTRAINT agent_triggers_pkey PRIMARY KEY (workspace_id, agent_id, id);

ALTER TABLE ONLY agent_versions
    ADD CONSTRAINT agent_versions_pkey PRIMARY KEY (workspace_id, agent_id, id);

ALTER TABLE ONLY agent_versions
    ADD CONSTRAINT agent_versions_workspace_id_agent_id_version_id_key UNIQUE (workspace_id, agent_id, version, id);

ALTER TABLE ONLY automation_dispatch_outbox
    ADD CONSTRAINT automation_dispatch_outbox_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY automation_dispatch_outbox
    ADD CONSTRAINT automation_dispatch_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automation_run_approvals
    ADD CONSTRAINT automation_run_approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automation_run_approvals
    ADD CONSTRAINT automation_run_approvals_source_type_run_id_tool_call_id_key UNIQUE (source_type, run_id, tool_call_id);

ALTER TABLE ONLY automation_run_continuations
    ADD CONSTRAINT automation_run_continuations_pkey PRIMARY KEY (source_type, run_id);

ALTER TABLE ONLY automation_template_installations
    ADD CONSTRAINT automation_template_installations_pkey PRIMARY KEY (workspace_id, template_id);

ALTER TABLE ONLY automation_trigger_deliveries
    ADD CONSTRAINT automation_trigger_deliveries_event_id_trigger_id_key UNIQUE (event_id, trigger_id);

ALTER TABLE ONLY automation_trigger_deliveries
    ADD CONSTRAINT automation_trigger_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automation_trigger_events
    ADD CONSTRAINT automation_trigger_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automation_trigger_events
    ADD CONSTRAINT automation_trigger_events_workspace_id_source_type_source_i_key UNIQUE (workspace_id, source_type, source_id, occurrence_key);

ALTER TABLE ONLY capability_routing_mappings
    ADD CONSTRAINT capability_routing_mappings_pkey PRIMARY KEY (workspace_id, id);

ALTER TABLE ONLY chat_activity_events
    ADD CONSTRAINT chat_activity_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY external_integration_link_tokens
    ADD CONSTRAINT external_integration_link_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY external_integration_link_tokens
    ADD CONSTRAINT external_integration_link_tokens_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY external_integration_user_links
    ADD CONSTRAINT external_integration_user_lin_integration_client_id_provide_key UNIQUE (integration_client_id, provider, external_user_id);

ALTER TABLE ONLY external_integration_user_links
    ADD CONSTRAINT external_integration_user_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY external_integration_workspace_grants
    ADD CONSTRAINT external_integration_workspace_grants_link_workspace_key UNIQUE (external_integration_user_link_id, workspace_id);

ALTER TABLE ONLY external_integration_workspace_grants
    ADD CONSTRAINT external_integration_workspace_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY external_webhook_route_connections
    ADD CONSTRAINT external_webhook_route_connections_pkey PRIMARY KEY (external_integration_user_link_id, delivery_url);

ALTER TABLE ONLY kubernetes_target_settings
    ADD CONSTRAINT kubernetes_target_settings_pkey PRIMARY KEY (target_id);

ALTER TABLE ONLY mcp_secret_cleanup_jobs
    ADD CONSTRAINT mcp_secret_cleanup_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY role_templates
    ADD CONSTRAINT role_templates_pkey PRIMARY KEY (key);

ALTER TABLE ONLY run_continuations
    ADD CONSTRAINT run_continuations_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY run_events
    ADD CONSTRAINT run_events_pkey PRIMARY KEY (run_id, seq);

ALTER TABLE ONLY run_skill_catalog_snapshots
    ADD CONSTRAINT run_skill_catalog_snapshots_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY run_skill_snapshots
    ADD CONSTRAINT run_skill_snapshots_pkey PRIMARY KEY (run_id, skill_ref);

ALTER TABLE ONLY run_tool_approvals
    ADD CONSTRAINT run_tool_approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY run_tool_result_artifacts
    ADD CONSTRAINT run_tool_result_artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY service_identities
    ADD CONSTRAINT service_identities_pkey PRIMARY KEY (workspace_id, id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY skill_snapshot_blobs
    ADD CONSTRAINT skill_snapshot_blobs_pkey PRIMARY KEY (content_hash);

ALTER TABLE ONLY target_agent_registrations
    ADD CONSTRAINT target_agent_registrations_pkey PRIMARY KEY (target_id);

ALTER TABLE ONLY target_findings
    ADD CONSTRAINT target_findings_pkey PRIMARY KEY (target_id, finding_id);

ALTER TABLE ONLY target_insights_checkpoint_jobs
    ADD CONSTRAINT target_insights_checkpoint_jobs_pkey PRIMARY KEY (workspace_id, target_id, session_id);

ALTER TABLE ONLY target_insights_entries
    ADD CONSTRAINT target_insights_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY target_inventory_items
    ADD CONSTRAINT target_inventory_items_pkey PRIMARY KEY (target_id, item_id);

ALTER TABLE ONLY target_issue_observations
    ADD CONSTRAINT target_issue_observations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY target_issues
    ADD CONSTRAINT target_issues_pkey PRIMARY KEY (id);

ALTER TABLE ONLY target_issues
    ADD CONSTRAINT target_issues_target_id_fingerprint_key UNIQUE (target_id, fingerprint);

ALTER TABLE ONLY target_metric_history
    ADD CONSTRAINT target_metric_history_pkey PRIMARY KEY (target_id, sample_ts);

ALTER TABLE ONLY target_skill_files
    ADD CONSTRAINT target_skill_files_pkey PRIMARY KEY (skill_id, path);

ALTER TABLE ONLY target_skills
    ADD CONSTRAINT target_skills_pkey PRIMARY KEY (id);

ALTER TABLE ONLY target_skills
    ADD CONSTRAINT target_skills_target_scope_unique UNIQUE (target_id, id);

ALTER TABLE ONLY target_snapshot_summaries
    ADD CONSTRAINT target_snapshot_summaries_pkey PRIMARY KEY (target_id);

ALTER TABLE ONLY target_snapshots
    ADD CONSTRAINT target_snapshots_pkey PRIMARY KEY (target_id);

ALTER TABLE ONLY target_tool_overrides
    ADD CONSTRAINT target_tool_overrides_pkey PRIMARY KEY (target_id, tool_name);

ALTER TABLE ONLY target_tool_settings
    ADD CONSTRAINT target_tool_settings_pkey PRIMARY KEY (target_id, tool_id);

ALTER TABLE ONLY targets
    ADD CONSTRAINT targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY targets
    ADD CONSTRAINT targets_workspace_id_id_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY run_tool_result_artifacts
    ADD CONSTRAINT uq_run_tool_result_artifacts_call UNIQUE (run_id, call_id);

ALTER TABLE ONLY user_email_verification_tokens
    ADD CONSTRAINT user_email_verification_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY user_email_verification_tokens
    ADD CONSTRAINT user_email_verification_tokens_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY user_federated_identities
    ADD CONSTRAINT user_federated_identities_pkey PRIMARY KEY (provider, subject);

ALTER TABLE ONLY user_password_credentials
    ADD CONSTRAINT user_password_credentials_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY user_password_credentials
    ADD CONSTRAINT user_password_credentials_username_key UNIQUE (username);

ALTER TABLE ONLY user_password_reset_tokens
    ADD CONSTRAINT user_password_reset_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY user_password_reset_tokens
    ADD CONSTRAINT user_password_reset_tokens_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhook_history
    ADD CONSTRAINT webhook_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhook_outbox_events
    ADD CONSTRAINT webhook_outbox_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhook_outbox_events
    ADD CONSTRAINT webhook_outbox_events_dedupe_key_key UNIQUE (dedupe_key);

ALTER TABLE ONLY webhook_delivery_jobs
    ADD CONSTRAINT webhook_delivery_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhook_delivery_jobs
    ADD CONSTRAINT webhook_delivery_jobs_event_id_subscription_id_key UNIQUE (event_id, subscription_id);

ALTER TABLE ONLY webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_approvals
    ADD CONSTRAINT workflow_approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_definitions
    ADD CONSTRAINT workflow_definitions_pkey PRIMARY KEY (workspace_id, id);

ALTER TABLE ONLY workflow_delegations
    ADD CONSTRAINT workflow_delegations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_executions
    ADD CONSTRAINT workflow_executions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_executions
    ADD CONSTRAINT workflow_executions_workspace_id_client_request_id_key UNIQUE (workspace_id, client_request_id);

ALTER TABLE ONLY workflow_executions
    ADD CONSTRAINT workflow_executions_workspace_id_trigger_id_occurrence_key_key UNIQUE (workspace_id, trigger_id, occurrence_key);

ALTER TABLE ONLY workflow_mcp_servers
    ADD CONSTRAINT workflow_mcp_servers_pkey PRIMARY KEY (workspace_id, id);

ALTER TABLE ONLY workflow_messages
    ADD CONSTRAINT workflow_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_reports
    ADD CONSTRAINT workflow_reports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_run_events
    ADD CONSTRAINT workflow_run_events_pkey PRIMARY KEY (run_id, seq);

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT workflow_runs_idempotency_key_unique UNIQUE (idempotency_key);

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT workflow_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_schedules
    ADD CONSTRAINT workflow_schedules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_sessions
    ADD CONSTRAINT workflow_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_ai_settings
    ADD CONSTRAINT workspace_ai_settings_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY workspace_audit_events
    ADD CONSTRAINT workspace_audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_invitations
    ADD CONSTRAINT workspace_invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_invitations
    ADD CONSTRAINT workspace_invitations_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY workspace_membership_audit
    ADD CONSTRAINT workspace_membership_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_memberships
    ADD CONSTRAINT workspace_memberships_pkey PRIMARY KEY (workspace_id, user_id);

ALTER TABLE ONLY workspace_quota_overrides
    ADD CONSTRAINT workspace_quota_overrides_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY workspace_skills
    ADD CONSTRAINT workspace_skills_name_unique UNIQUE (workspace_id, name);

ALTER TABLE ONLY workspace_skills
    ADD CONSTRAINT workspace_skills_pkey PRIMARY KEY (workspace_id, id);

ALTER TABLE ONLY workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);

CREATE INDEX admin_audit_events_action_idx ON admin_audit_events USING btree (action, occurred_at DESC, id DESC);

CREATE INDEX admin_audit_events_occurred_at_idx ON admin_audit_events USING btree (occurred_at DESC, id DESC);

CREATE INDEX admin_audit_events_token_idx ON admin_audit_events USING btree (admin_token_id, occurred_at DESC, id DESC);

CREATE INDEX admin_audit_events_workspace_idx ON admin_audit_events USING btree (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX agent_activity_agent_created_idx ON agent_activity USING btree (workspace_id, agent_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX agent_activity_idempotency_unique ON agent_activity USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE UNIQUE INDEX agent_activity_workspace_client_request_unique ON agent_activity USING btree (workspace_id, client_request_id) WHERE (client_request_id IS NOT NULL);

CREATE INDEX agent_definitions_workspace_owner_idx ON agent_definitions USING btree (workspace_id, owner_user_id, updated_at DESC);

CREATE INDEX agent_definitions_workspace_status_idx ON agent_definitions USING btree (workspace_id, status, updated_at DESC, id);

CREATE UNIQUE INDEX agent_definitions_workspace_system_role_unique ON agent_definitions USING btree (workspace_id, system_role) WHERE (system_role IS NOT NULL);

CREATE INDEX agent_run_events_created_idx ON agent_run_events USING btree (run_id, created_at, seq);

CREATE INDEX agent_skills_agent_enabled_idx ON agent_skills USING btree (workspace_id, agent_id, enabled, name);

CREATE UNIQUE INDEX agent_triggers_global_id_unique ON agent_triggers USING btree (id);

CREATE INDEX agent_triggers_schedule_claim_idx ON agent_triggers USING btree (next_occurrence_at, workspace_id, agent_id, id) WHERE ((enabled = true) AND (type = 'schedule'::text));

CREATE INDEX agent_versions_agent_created_idx ON agent_versions USING btree (workspace_id, agent_id, created_at DESC, id DESC);

CREATE INDEX automation_dispatch_outbox_claim_idx ON automation_dispatch_outbox USING btree (next_attempt_at, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));

CREATE INDEX automation_dispatch_outbox_depth_idx ON automation_dispatch_outbox USING btree (workspace_id, status, created_at);

CREATE INDEX automation_run_approvals_expiry_idx ON automation_run_approvals USING btree (expires_at, id) WHERE (status = 'pending'::text);

CREATE INDEX automation_run_approvals_run_idx ON automation_run_approvals USING btree (source_type, run_id, created_at, id);

CREATE INDEX automation_run_approvals_workspace_status_idx ON automation_run_approvals USING btree (workspace_id, status, created_at DESC, id DESC);

CREATE INDEX automation_run_continuations_approval_idx ON automation_run_continuations USING btree (approval_id);

CREATE INDEX automation_trigger_deliveries_claim_idx ON automation_trigger_deliveries USING btree (next_attempt_at, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));

CREATE INDEX capability_routing_lookup_idx ON capability_routing_mappings USING btree (workspace_id, capability_id, status, review_state, priority, id);

CREATE INDEX idx_account_audit_events_occurred ON account_audit_events USING btree (occurred_at, id);

CREATE INDEX idx_account_audit_events_type ON account_audit_events USING btree (event_type, occurred_at DESC);

CREATE INDEX idx_account_audit_events_user_occurred ON account_audit_events USING btree (user_id, occurred_at DESC, id DESC);

CREATE INDEX idx_chat_activity_events_session ON chat_activity_events USING btree (session_id, id);

CREATE INDEX idx_chat_activity_events_target_replay ON chat_activity_events USING btree (workspace_id, target_id, id);

CREATE INDEX idx_external_integration_link_tokens_expires_at ON external_integration_link_tokens USING btree (expires_at);

CREATE INDEX idx_external_integration_link_tokens_identity ON external_integration_link_tokens USING btree (integration_client_id, provider, external_user_id);

CREATE INDEX idx_external_integration_user_links_active ON external_integration_user_links USING btree (integration_client_id, provider, external_user_id, expires_at) WHERE (revoked_at IS NULL);

CREATE INDEX idx_external_integration_user_links_user_active ON external_integration_user_links USING btree (acornops_user_id, revoked_at, expires_at);

CREATE INDEX idx_external_integration_user_links_user_id ON external_integration_user_links USING btree (acornops_user_id);

CREATE INDEX idx_external_integration_workspace_grants_link ON external_integration_workspace_grants USING btree (external_integration_user_link_id);

CREATE INDEX idx_external_integration_workspace_grants_workspace ON external_integration_workspace_grants USING btree (workspace_id);

CREATE INDEX idx_external_webhook_route_connections_identity ON external_webhook_route_connections USING btree (external_integration_user_link_id, integration_client_id, provider, external_user_id);

CREATE INDEX idx_inventory_items_search_trgm ON target_inventory_items USING gin (search_text gin_trgm_ops);

CREATE INDEX idx_inventory_items_target_attention_sort ON target_inventory_items USING btree (target_id, needs_attention, sort_key);

CREATE INDEX idx_inventory_items_target_category_sort ON target_inventory_items USING btree (target_id, category, sort_key);

CREATE INDEX idx_inventory_items_target_kind_sort ON target_inventory_items USING btree (target_id, kind, sort_key);

CREATE INDEX idx_inventory_items_target_scope_sort ON target_inventory_items USING btree (target_id, scope_name, sort_key);

CREATE INDEX idx_inventory_items_target_sort ON target_inventory_items USING btree (target_id, sort_key);

CREATE INDEX idx_mcp_secret_cleanup_jobs_due ON mcp_secret_cleanup_jobs USING btree (status, next_attempt_at, lease_expires_at);

CREATE UNIQUE INDEX idx_messages_run_assistant_final ON messages USING btree (run_id) WHERE ((run_id IS NOT NULL) AND (kind = 'assistant_final'::text));

CREATE UNIQUE INDEX idx_messages_session_client_message_id ON messages USING btree (session_id, client_message_id) WHERE (client_message_id IS NOT NULL);

CREATE INDEX idx_messages_session_created ON messages USING btree (session_id, created_at);

CREATE INDEX idx_messages_session_created_id ON messages USING btree (session_id, created_at DESC, id DESC);

CREATE INDEX idx_run_continuations_approval ON run_continuations USING btree (approval_id);

CREATE INDEX idx_run_events_run_id_seq ON run_events USING btree (run_id, seq);

CREATE INDEX idx_run_skill_snapshots_content_hash ON run_skill_snapshots USING btree (content_hash);

CREATE INDEX idx_run_skill_snapshots_run_skill_id ON run_skill_snapshots USING btree (run_id, skill_id);

CREATE UNIQUE INDEX idx_run_tool_approvals_run_call ON run_tool_approvals USING btree (run_id, tool_call_id);

CREATE INDEX idx_run_tool_approvals_run_status ON run_tool_approvals USING btree (run_id, status, created_at DESC);

CREATE INDEX idx_run_tool_result_artifacts_expiry ON run_tool_result_artifacts USING btree (expires_at);

CREATE INDEX idx_runs_session_id ON runs USING btree (session_id);

CREATE INDEX idx_runs_session_requested ON runs USING btree (session_id, requested_at DESC, id DESC);

CREATE INDEX idx_runs_external_integration_origin ON runs USING btree (request_external_integration_link_id, requested_at DESC) WHERE (request_actor_type = 'external_integration'::text);

CREATE INDEX idx_sessions_target_last_message ON sessions USING btree (target_id, last_message_at DESC);

CREATE INDEX idx_sessions_workspace_target ON sessions USING btree (workspace_id, target_id);

CREATE INDEX idx_sessions_workspace_target_last_message_id ON sessions USING btree (workspace_id, target_id, last_message_at DESC, id DESC) WHERE (deleted_at IS NULL);

CREATE INDEX idx_skill_snapshot_blobs_last_referenced_at ON skill_snapshot_blobs USING btree (last_referenced_at);

CREATE INDEX idx_snapshot_summaries_workspace_target ON target_snapshot_summaries USING btree (workspace_id, target_id);

CREATE INDEX idx_target_findings_search_trgm ON target_findings USING gin (search_text gin_trgm_ops);

CREATE INDEX idx_target_findings_target_order ON target_findings USING btree (target_id, severity_rank, finding_ts DESC, finding_id);

CREATE INDEX idx_target_findings_workspace_order ON target_findings USING btree (workspace_id, severity_rank, finding_ts DESC, finding_id);

CREATE INDEX idx_target_findings_workspace_scope_order ON target_findings USING btree (workspace_id, scope_name, severity_rank, finding_ts DESC, finding_id);

CREATE INDEX idx_target_findings_workspace_target_order ON target_findings USING btree (workspace_id, target_id, severity_rank, finding_ts DESC, finding_id);

CREATE INDEX idx_target_insights_checkpoint_jobs_due ON target_insights_checkpoint_jobs USING btree (status, due_at, retry_after, lease_expires_at) WHERE (due_at IS NOT NULL);

CREATE INDEX idx_target_insights_checkpoint_jobs_target ON target_insights_checkpoint_jobs USING btree (workspace_id, target_id, updated_at DESC);

CREATE INDEX idx_target_insights_entries_search ON target_insights_entries USING gin (to_tsvector('simple'::regconfig, ((((title || ' '::text) || body_markdown) || ' '::text) || evidence_summary)));

CREATE INDEX idx_target_insights_entries_tags ON target_insights_entries USING gin (tags);

CREATE INDEX idx_target_insights_entries_target_status ON target_insights_entries USING btree (target_id, status, updated_at DESC);

CREATE INDEX idx_target_insights_entries_workspace_target ON target_insights_entries USING btree (workspace_id, target_id, updated_at DESC);

CREATE INDEX idx_target_issue_observations_issue_ts ON target_issue_observations USING btree (issue_id, snapshot_ts DESC, id);

CREATE INDEX idx_target_issues_search_trgm ON target_issues USING gin (search_text gin_trgm_ops);

CREATE INDEX idx_target_issues_workspace_order ON target_issues USING btree (workspace_id, status, severity_rank, last_seen_at DESC, id);

CREATE INDEX idx_target_issues_workspace_scope_order ON target_issues USING btree (workspace_id, scope_name, status, severity_rank, last_seen_at DESC, id);

CREATE INDEX idx_target_issues_workspace_target_order ON target_issues USING btree (workspace_id, target_id, status, severity_rank, last_seen_at DESC, id);

CREATE INDEX idx_target_metric_history_target_ts ON target_metric_history USING btree (target_id, sample_ts DESC);

CREATE INDEX idx_target_metric_history_workspace_target_ts ON target_metric_history USING btree (workspace_id, target_id, sample_ts DESC);

CREATE INDEX idx_target_skill_files_skill_path ON target_skill_files USING btree (skill_id, path);

CREATE INDEX idx_target_skills_target_enabled_valid ON target_skills USING btree (target_id, enabled, validation_status);

CREATE INDEX idx_target_skills_target_updated ON target_skills USING btree (target_id, updated_at DESC, id DESC);

CREATE INDEX idx_target_tool_overrides_target ON target_tool_overrides USING btree (target_id);

CREATE INDEX idx_target_tool_settings_target ON target_tool_settings USING btree (target_id);

CREATE INDEX idx_targets_workspace_type ON targets USING btree (workspace_id, target_type);

CREATE INDEX idx_targets_workspace_type_status_created_id ON targets USING btree (workspace_id, target_type, status, created_at, id);

CREATE INDEX idx_user_email_verification_tokens_expires_at ON user_email_verification_tokens USING btree (expires_at);

CREATE INDEX idx_user_email_verification_tokens_user_email ON user_email_verification_tokens USING btree (user_id, email);

CREATE INDEX idx_user_federated_identities_last_login ON user_federated_identities USING btree (last_login_at DESC);

CREATE INDEX idx_user_federated_identities_user_id ON user_federated_identities USING btree (user_id);

CREATE INDEX idx_user_password_credentials_last_login ON user_password_credentials USING btree (last_login_at DESC);

CREATE INDEX idx_user_password_reset_tokens_expires_at ON user_password_reset_tokens USING btree (expires_at);

CREATE INDEX idx_user_password_reset_tokens_user_email ON user_password_reset_tokens USING btree (user_id, email);

CREATE INDEX idx_webhook_history_event_id ON webhook_history USING btree (event_id);

CREATE INDEX idx_webhook_history_subscription_sent_at ON webhook_history USING btree (subscription_id, sent_at DESC);

CREATE INDEX idx_webhook_history_workspace_sent_at ON webhook_history USING btree (workspace_id, sent_at DESC);

CREATE INDEX idx_webhook_delivery_jobs_due ON webhook_delivery_jobs USING btree (status, next_attempt_at, lease_expires_at, created_at);

CREATE INDEX idx_webhook_delivery_jobs_subscription ON webhook_delivery_jobs USING btree (subscription_id, status);

CREATE INDEX idx_webhook_outbox_events_subject ON webhook_outbox_events USING btree (subject_type, subject_id, occurred_at DESC);

CREATE INDEX idx_webhook_subscriptions_workspace_enabled ON webhook_subscriptions USING btree (workspace_id, enabled);

CREATE INDEX idx_webhook_subscriptions_created_by_url ON webhook_subscriptions USING btree (created_by, url);

CREATE INDEX idx_webhook_subscriptions_workspace_target ON webhook_subscriptions USING btree (workspace_id, target_id);

CREATE INDEX idx_workspace_audit_events_occurred ON workspace_audit_events USING btree (occurred_at, id);

CREATE INDEX idx_workspace_audit_events_workspace_category ON workspace_audit_events USING btree (workspace_id, category, occurred_at DESC);

CREATE INDEX idx_workspace_audit_events_workspace_occurred ON workspace_audit_events USING btree (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX idx_workspace_audit_events_workspace_type ON workspace_audit_events USING btree (workspace_id, event_type, occurred_at DESC);

CREATE INDEX idx_workspace_invitations_email_status ON workspace_invitations USING btree (email, status, expires_at);

CREATE INDEX idx_workspace_invitations_workspace_role ON workspace_invitations USING btree (workspace_id, role);

CREATE INDEX idx_workspace_invitations_workspace_status ON workspace_invitations USING btree (workspace_id, status, expires_at);

CREATE INDEX idx_workspace_invitations_workspace_status_created_id ON workspace_invitations USING btree (workspace_id, status, created_at DESC, id DESC);

CREATE INDEX idx_workspace_membership_audit_workspace_created ON workspace_membership_audit USING btree (workspace_id, created_at DESC);

CREATE INDEX idx_workspace_memberships_user_id ON workspace_memberships USING btree (user_id);

CREATE INDEX idx_workspace_memberships_workspace_role ON workspace_memberships USING btree (workspace_id, role);

CREATE INDEX idx_workspace_memberships_workspace_role_user ON workspace_memberships USING btree (workspace_id, role, user_id);

CREATE INDEX idx_workspaces_created_id ON workspaces USING btree (created_at, id);

CREATE INDEX service_identities_workspace_status_idx ON service_identities USING btree (workspace_id, status, id);

CREATE UNIQUE INDEX uq_mcp_secret_cleanup_jobs_scope ON mcp_secret_cleanup_jobs USING btree (workspace_id, COALESCE(user_id, ''::text), reason);

CREATE INDEX workflow_approvals_expiry_idx ON workflow_approvals USING btree (expires_at, id) WHERE (status = 'pending'::text);

CREATE INDEX workflow_approvals_workspace_status_idx ON workflow_approvals USING btree (workspace_id, status, created_at DESC, id DESC);

CREATE INDEX workflow_definitions_workspace_status_idx ON workflow_definitions USING btree (workspace_id, status, updated_at DESC, id);

CREATE INDEX workflow_delegations_parent_idx ON workflow_delegations USING btree (parent_execution_id, status, created_at, id);

CREATE INDEX workflow_executions_resumable_idx ON workflow_executions USING btree (updated_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'needs_review'::text, 'failed'::text]));

CREATE INDEX workflow_executions_workspace_status_idx ON workflow_executions USING btree (workspace_id, status, updated_at, id);

CREATE INDEX workflow_messages_session_created_idx ON workflow_messages USING btree (session_id, created_at, id);

CREATE INDEX workflow_reports_retention_idx ON workflow_reports USING btree (retention_expires_at, id);

CREATE UNIQUE INDEX workflow_reports_run_tool_call_unique ON workflow_reports USING btree (run_id, tool_call_id) WHERE (tool_call_id IS NOT NULL);

CREATE UNIQUE INDEX workflow_reports_target_run_tool_call_unique ON workflow_reports USING btree (target_run_id, tool_call_id) WHERE ((target_run_id IS NOT NULL) AND (tool_call_id IS NOT NULL));

CREATE INDEX workflow_run_events_created_idx ON workflow_run_events USING btree (run_id, created_at, seq);

CREATE INDEX workflow_execution_events_replay_idx ON workflow_execution_events USING btree (execution_id, id);

CREATE INDEX idx_workflow_executions_external_integration_origin ON workflow_executions USING btree (request_external_integration_link_id, updated_at DESC) WHERE (request_actor_type = 'external_integration'::text);

CREATE INDEX workflow_runs_claim_idx ON workflow_runs USING btree (next_attempt_at, requested_at, id) WHERE ((status = ANY (ARRAY['queued'::text, 'dispatching'::text])) AND (cancellation_requested_at IS NULL));

CREATE INDEX workflow_runs_prompt_digest_idx ON workflow_runs USING btree (workspace_id, prompt_digest, requested_at DESC);

CREATE INDEX workflow_runs_session_requested_idx ON workflow_runs USING btree (workflow_session_id, requested_at DESC, id DESC);

CREATE INDEX workflow_runs_workspace_status_idx ON workflow_runs USING btree (workspace_id, status, requested_at DESC, id DESC);

CREATE INDEX workflow_schedules_due_idx ON workflow_schedules USING btree (next_run_at, id) WHERE (status = 'enabled'::text);

CREATE INDEX workflow_schedules_workspace_idx ON workflow_schedules USING btree (workspace_id, next_run_at, id);

CREATE INDEX workflow_sessions_workflow_created_idx ON workflow_sessions USING btree (workspace_id, workflow_id, created_at DESC, id DESC);

CREATE INDEX idx_workflow_sessions_external_integration_origin ON workflow_sessions USING btree (request_external_integration_link_id, created_at DESC) WHERE (request_actor_type = 'external_integration'::text);

CREATE INDEX workspace_skills_workspace_enabled_valid_name_idx ON workspace_skills USING btree (workspace_id, enabled, validation_status, name, id);

ALTER TABLE ONLY account_audit_events
    ADD CONSTRAINT account_audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY account_audit_events
    ADD CONSTRAINT account_audit_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY agent_activity
    ADD CONSTRAINT agent_activity_workspace_id_agent_id_fkey FOREIGN KEY (workspace_id, agent_id) REFERENCES agent_definitions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_definitions
    ADD CONSTRAINT agent_definitions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_run_events
    ADD CONSTRAINT agent_run_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_run_events
    ADD CONSTRAINT agent_run_events_workspace_id_run_id_fkey FOREIGN KEY (workspace_id, run_id) REFERENCES agent_activity(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_skill_files
    ADD CONSTRAINT agent_skill_files_workspace_id_agent_id_skill_id_fkey FOREIGN KEY (workspace_id, agent_id, skill_id) REFERENCES agent_skills(workspace_id, agent_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_skills
    ADD CONSTRAINT agent_skills_workspace_id_agent_id_fkey FOREIGN KEY (workspace_id, agent_id) REFERENCES agent_definitions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_triggers
    ADD CONSTRAINT agent_triggers_workspace_id_agent_id_fkey FOREIGN KEY (workspace_id, agent_id) REFERENCES agent_definitions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_versions
    ADD CONSTRAINT agent_versions_workspace_id_agent_id_fkey FOREIGN KEY (workspace_id, agent_id) REFERENCES agent_definitions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_dispatch_outbox
    ADD CONSTRAINT automation_dispatch_outbox_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_run_approvals
    ADD CONSTRAINT automation_run_approvals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_run_continuations
    ADD CONSTRAINT automation_run_continuations_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES automation_run_approvals(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_template_installations
    ADD CONSTRAINT automation_template_installations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_trigger_deliveries
    ADD CONSTRAINT automation_trigger_deliveries_event_id_fkey FOREIGN KEY (event_id) REFERENCES automation_trigger_events(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_trigger_deliveries
    ADD CONSTRAINT automation_trigger_deliveries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_trigger_events
    ADD CONSTRAINT automation_trigger_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_routing_mappings
    ADD CONSTRAINT capability_routing_mappings_workspace_id_agent_id_fkey FOREIGN KEY (workspace_id, agent_id) REFERENCES agent_definitions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_routing_mappings
    ADD CONSTRAINT capability_routing_mappings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY external_integration_user_links
    ADD CONSTRAINT external_integration_user_links_acornops_user_id_fkey FOREIGN KEY (acornops_user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY external_integration_workspace_grants
    ADD CONSTRAINT external_integration_workspace_grants_granted_by_user_id_fkey FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY external_integration_workspace_grants
    ADD CONSTRAINT external_integration_workspace_grants_link_id_fkey FOREIGN KEY (external_integration_user_link_id) REFERENCES external_integration_user_links(id) ON DELETE CASCADE;

ALTER TABLE ONLY external_integration_workspace_grants
    ADD CONSTRAINT external_integration_workspace_grants_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY external_webhook_route_connections
    ADD CONSTRAINT external_webhook_route_connections_link_id_fkey FOREIGN KEY (external_integration_user_link_id) REFERENCES external_integration_user_links(id) ON DELETE CASCADE;

ALTER TABLE ONLY chat_activity_events
    ADD CONSTRAINT fk_chat_activity_events_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY messages
    ADD CONSTRAINT fk_messages_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_events
    ADD CONSTRAINT fk_run_events_run FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_tool_approvals
    ADD CONSTRAINT fk_run_tool_approvals_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY run_tool_result_artifacts
    ADD CONSTRAINT fk_run_tool_result_artifacts_run FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY runs
    ADD CONSTRAINT fk_runs_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY runs
    ADD CONSTRAINT fk_runs_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT fk_sessions_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY target_agent_registrations
    ADD CONSTRAINT fk_target_agent_registrations_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY target_findings
    ADD CONSTRAINT fk_target_findings_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY target_inventory_items
    ADD CONSTRAINT fk_target_inventory_items_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY target_issue_observations
    ADD CONSTRAINT fk_target_issue_observations_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY target_issues
    ADD CONSTRAINT fk_target_issues_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY target_metric_history
    ADD CONSTRAINT fk_target_metric_history_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY target_snapshot_summaries
    ADD CONSTRAINT fk_target_snapshot_summaries_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY target_snapshots
    ADD CONSTRAINT fk_target_snapshots_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_history
    ADD CONSTRAINT fk_webhook_history_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_subscriptions
    ADD CONSTRAINT fk_webhook_subscriptions_workspace_target FOREIGN KEY (workspace_id, target_id) REFERENCES targets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY kubernetes_target_settings
    ADD CONSTRAINT kubernetes_target_settings_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_continuations
    ADD CONSTRAINT run_continuations_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES run_tool_approvals(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_continuations
    ADD CONSTRAINT run_continuations_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_skill_catalog_snapshots
    ADD CONSTRAINT run_skill_catalog_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_skill_snapshots
    ADD CONSTRAINT run_skill_snapshots_content_hash_fkey FOREIGN KEY (content_hash) REFERENCES skill_snapshot_blobs(content_hash);

ALTER TABLE ONLY run_skill_snapshots
    ADD CONSTRAINT run_skill_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_tool_approvals
    ADD CONSTRAINT run_tool_approvals_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY runs
    ADD CONSTRAINT runs_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY service_identities
    ADD CONSTRAINT service_identities_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_agent_registrations
    ADD CONSTRAINT target_agent_registrations_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_findings
    ADD CONSTRAINT target_findings_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_findings
    ADD CONSTRAINT target_findings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_insights_checkpoint_jobs
    ADD CONSTRAINT target_insights_checkpoint_jobs_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_insights_checkpoint_jobs
    ADD CONSTRAINT target_insights_checkpoint_jobs_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_insights_checkpoint_jobs
    ADD CONSTRAINT target_insights_checkpoint_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_insights_entries
    ADD CONSTRAINT target_insights_entries_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_insights_entries
    ADD CONSTRAINT target_insights_entries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_inventory_items
    ADD CONSTRAINT target_inventory_items_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_inventory_items
    ADD CONSTRAINT target_inventory_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_issue_observations
    ADD CONSTRAINT target_issue_observations_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES target_issues(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_issue_observations
    ADD CONSTRAINT target_issue_observations_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_issue_observations
    ADD CONSTRAINT target_issue_observations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_issues
    ADD CONSTRAINT target_issues_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_issues
    ADD CONSTRAINT target_issues_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_metric_history
    ADD CONSTRAINT target_metric_history_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_metric_history
    ADD CONSTRAINT target_metric_history_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_skill_files
    ADD CONSTRAINT target_skill_files_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES target_skills(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_skills
    ADD CONSTRAINT target_skills_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;
ALTER TABLE ONLY target_skills
    ADD CONSTRAINT target_skills_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_snapshot_summaries
    ADD CONSTRAINT target_snapshot_summaries_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_snapshot_summaries
    ADD CONSTRAINT target_snapshot_summaries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_snapshots
    ADD CONSTRAINT target_snapshots_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_tool_overrides
    ADD CONSTRAINT target_tool_overrides_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY target_tool_settings
    ADD CONSTRAINT target_tool_settings_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY targets
    ADD CONSTRAINT targets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_email_verification_tokens
    ADD CONSTRAINT user_email_verification_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_federated_identities
    ADD CONSTRAINT user_federated_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_password_credentials
    ADD CONSTRAINT user_password_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_password_reset_tokens
    ADD CONSTRAINT user_password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_history
    ADD CONSTRAINT webhook_history_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_history
    ADD CONSTRAINT webhook_history_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_delivery_jobs
    ADD CONSTRAINT webhook_delivery_jobs_event_id_fkey FOREIGN KEY (event_id) REFERENCES webhook_outbox_events(id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_approvals
    ADD CONSTRAINT workflow_approvals_run_id_fkey FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_approvals
    ADD CONSTRAINT workflow_approvals_workflow_session_id_fkey FOREIGN KEY (workflow_session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_approvals
    ADD CONSTRAINT workflow_approvals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_definitions
    ADD CONSTRAINT workflow_definitions_entry_agent_fk FOREIGN KEY (workspace_id, entry_agent_id) REFERENCES agent_definitions(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY workflow_definitions
    ADD CONSTRAINT workflow_definitions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_delegations
    ADD CONSTRAINT workflow_delegations_parent_execution_id_fkey FOREIGN KEY (parent_execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_delegations
    ADD CONSTRAINT workflow_delegations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_delegations
    ADD CONSTRAINT workflow_delegations_workspace_id_selected_agent_id_fkey FOREIGN KEY (workspace_id, selected_agent_id) REFERENCES agent_definitions(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY workflow_executions
    ADD CONSTRAINT workflow_executions_message_id_fkey FOREIGN KEY (message_id) REFERENCES workflow_messages(id) ON DELETE RESTRICT;

ALTER TABLE ONLY workflow_executions
    ADD CONSTRAINT workflow_executions_workflow_session_id_fkey FOREIGN KEY (workflow_session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_executions
    ADD CONSTRAINT workflow_executions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_executions
    ADD CONSTRAINT workflow_executions_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES workflow_definitions(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY workflow_execution_events
    ADD CONSTRAINT workflow_execution_events_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_execution_events
    ADD CONSTRAINT workflow_execution_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_execution_events
    ADD CONSTRAINT workflow_execution_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_mcp_servers
    ADD CONSTRAINT workflow_mcp_servers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_messages
    ADD CONSTRAINT workflow_messages_run_fk FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY workflow_messages
    ADD CONSTRAINT workflow_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_messages
    ADD CONSTRAINT workflow_messages_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_reports
    ADD CONSTRAINT workflow_reports_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_reports
    ADD CONSTRAINT workflow_reports_run_id_fkey FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_reports
    ADD CONSTRAINT workflow_reports_target_run_id_fkey FOREIGN KEY (target_run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_reports
    ADD CONSTRAINT workflow_reports_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_run_events
    ADD CONSTRAINT workflow_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT workflow_runs_execution_fk FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT workflow_runs_message_id_fkey FOREIGN KEY (message_id) REFERENCES workflow_messages(id) ON DELETE RESTRICT;

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT workflow_runs_workflow_session_id_fkey FOREIGN KEY (workflow_session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT workflow_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_schedules
    ADD CONSTRAINT workflow_schedules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_schedules
    ADD CONSTRAINT workflow_schedules_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES workflow_definitions(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY workflow_sessions
    ADD CONSTRAINT workflow_sessions_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES workflow_definitions(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY workspace_ai_settings
    ADD CONSTRAINT workspace_ai_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_invitations
    ADD CONSTRAINT workspace_invitations_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY workspace_invitations
    ADD CONSTRAINT workspace_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY workspace_invitations
    ADD CONSTRAINT workspace_invitations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_quota_overrides
    ADD CONSTRAINT workspace_quota_overrides_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_skills
    ADD CONSTRAINT workspace_skills_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
