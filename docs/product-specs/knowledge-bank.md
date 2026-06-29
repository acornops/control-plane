# Knowledge Bank

Status: Active

Knowledge Bank is a target-scoped built-in assistant tool that improves future troubleshooting by retrieving and learning operational knowledge. It is not user preference memory, not a skill, not an MCP server, and not vectorized.

## Product Contract

- The platform flag `KNOWLEDGE_BANK_ENABLED` controls whether the feature is exposed. It defaults to enabled.
- When the platform flag is enabled, `knowledge_bank` appears in target tools and is enabled by default per target.
- There is no auto-update setting. If the tool is enabled, learning runs automatically when prerequisites are met.
- Knowledge is scoped to the target. Current target types are Kubernetes clusters and virtual machines.
- Durable updates never happen inside a live assistant run. Runs can retrieve active snippets and show those snippets in run details.
- Background learning needs configured AI settings. Missing credentials or disallowed model policy pauses learning but does not break viewing, editing, retrieval, or assistant runs.
- Target tool listing must stay fast and must not perform live LLM gateway credential checks. The tool readiness shown in the catalog is a local policy/configuration check. The checkpoint worker performs the authoritative credential check when it actually learns.
- Reset hard-deletes the target's Knowledge Bank entries and checkpoint jobs. Audit and run history remain intact.

## Data Model

Postgres is the source of truth.

- `target_knowledge_entries` stores target-scoped Markdown entries plus structured metadata: status, tags, signals, scope, evidence summary, observation count, confidence, first and last observed timestamps, and normal timestamps.
- `target_knowledge_checkpoint_jobs` stores one durable checkpoint job per workspace, target, and session. Each job records the last observed session activity, due time, processing status, lease, retry state, attempt count, and last error.
- Entry statuses are `active`, `pending`, and `archived`.
- Evidence is stored as concise summaries and normalized signals. Source run IDs are intentionally not stored in knowledge entries; audit and run history remain the evidence trail.
- OKF-style Markdown with YAML frontmatter is the portability and export format.

## Retrieval

Retrieval is lexical and deterministic. It does not use embeddings, a vector database, or provider-specific embedding models.

The control plane searches only `active` entries for the current target. Ranking combines:

- Postgres full-text rank over title, Markdown body, and evidence summary.
- Exact overlap between query terms and entry tags.
- Exact overlap against normalized signal and scope keys or values.
- Confidence, observation count, scope specificity, and recency.

If no entries match, no Knowledge Bank context is injected. If entries match, the control plane injects a compact system context block and returns snippet metadata in the run context. The execution engine emits a `knowledge_context_retrieved` run event so run details can show what was retrieved.

## Learning

The control plane owns checkpoint scheduling and persistence.

- Message activity upserts a durable checkpoint job for the session. The job due time is computed from the target's configured idle delay, so the worker does not need to scan all sessions to discover work.
- A lightweight periodic worker claims only due jobs with `FOR UPDATE SKIP LOCKED`. The existing process-level Redis lease still prevents every control-plane replica from starting the same sweep at once; the database job lease is the durable source of truth. Expired `processing` leases are reclaimable after worker crashes.
- Claimed jobs must still have no active run and no pending approval. If a run or approval is active, the worker reschedules the job instead of learning from an in-progress conversation.
- If newer session activity appears after a job was claimed, the worker requeues the latest activity and abandons the stale job before calling the LLM.
- If target tool settings change the idle delay after a job was enqueued, the worker recomputes eligibility from the current config before learning and reschedules early jobs.
- The worker resolves the checkpoint model from the target tool config. The default is the workspace default model. A custom provider/model must pass existing AI policy and credential checks.
- If AI settings are missing or invalid, the checkpoint is skipped with a Knowledge Bank audit event and marked processed for the current session activity. New session activity or admin changes to AI settings, provider credentials, or Knowledge Bank tool settings can make it eligible again.
- The worker asks the model for a constrained JSON patch, validates the patch, and applies deterministic create, update, archive, or noop operations.
- After the model returns a patch, the worker renews the database job lease and applies entry mutations plus checkpoint completion in one short transaction. If the lease was lost, expired, or invalidated by newer session activity, the patch is not applied.
- Pending entries auto-promote to active when repeated evidence reaches `minimumObservationsBeforeGeneralization`.
- Repeated namespace-specific or host-specific observations are protected by a deterministic generalization layer. If a model proposes a new entry that materially overlaps an existing non-archived entry by tags, normalized signals, and title terms, the worker updates the existing entry instead of creating a duplicate.
- Generalization preserves shared scope fields and drops conflicting narrow fields such as `namespace`, `pod`, `node`, or `host`. This turns repeated evidence like "registry 401 in namespace A" and "registry 401 in namespace B" into a broader target entry while keeping normalized signals such as `error=401` and `component=image-pull`.
- The deterministic layer is deliberately conservative. If overlap is weak, the worker creates a pending entry rather than incorrectly merging unrelated incidents.

## Observability

Knowledge Bank exposes low-cardinality Prometheus metrics through the existing control-plane `/metrics` endpoint. Deployments can scrape these directly or route them through OpenTelemetry Collector into Elastic or another backend.

Metrics include:

- Retrieval outcomes: `hit`, `miss`, `skipped`, and `error`.
- Checkpoint outcomes by safe status/reason, for example `applied`, `noop`, `skipped:ai_settings_missing`, or `failed:exception`.
- Checkpoint duration buckets by terminal sweep status.
- Applied patch counts.

Metrics must not include workspace IDs, target IDs, session IDs, entry IDs, raw prompts, raw logs, or knowledge text.

## Permissions And Audit

`manage_knowledge_bank` controls mutation. Owner and admin role templates include it by default. Operators with target read access can view entries, activity, settings, and exported content but cannot edit, promote, archive, reset, or change config.

Knowledge Bank activity uses the existing workspace audit system with category `knowledge`. There is no separate logging mechanism.

Audited events include:

- `knowledge.entry.created.v1`
- `knowledge.entry.updated.v1`
- `knowledge.entry.archived.v1`
- `knowledge.entry.promoted.v1`
- `knowledge.bank.reset.v1`
- `knowledge.checkpoint.skipped.v1`
- `knowledge.checkpoint.applied.v1`
- `knowledge.tool.setting_updated.v1`

Checkpoint scheduling internals do not appear as chat runs.

## Configuration

Per-target tool config is intentionally small:

```ts
interface KnowledgeBankToolConfig {
  learning: {
    idleCheckpointDelayMinutes: number;
    minimumObservationsBeforeGeneralization: number;
    checkpointModel: {
      mode: 'workspace_default' | 'custom';
      provider?: LlmProvider;
      model?: string;
    };
  };
  retrieval: {
    maxSnippetsPerRetrieval: number;
    maxSnippetSizeBytes: number;
  };
}
```

Defaults:

- `idleCheckpointDelayMinutes`: `30`
- `minimumObservationsBeforeGeneralization`: `3`
- `checkpointModel.mode`: `workspace_default`
- `maxSnippetsPerRetrieval`: `4`
- `maxSnippetSizeBytes`: `1536`

## Non-Goals

- No vectorization or embeddings.
- No user preference memory.
- No user-facing "end run" button.
- No MCP server or skill storage.
- No compatibility adapters for unreleased legacy Knowledge Bank shapes.
