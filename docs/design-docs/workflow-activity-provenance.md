# Workflow Activity Provenance

The control plane exposes workspace workflow activity without reconstructing
origin from mutable schedules, triggers, or webhook requests.

## Persisted Boundary

Every workflow execution stores a non-null `origin_snapshot` when the execution
is created. The snapshot contains only the fields needed to explain the run:

- manual label or the registered external-integration client display name;
- schedule label and identifier; or
- event-trigger label, identifier, and a bounded issue or webhook source.

Webhook payloads, signing material, and raw occurrence keys never enter the
public provenance object. Trigger deletion does not affect the stored snapshot.
The greenfield baseline owns the final columns and indexes; there is no legacy
row backfill or compatibility mapper.

## Read Surfaces

`GET /api/v1/workspaces/{workspaceId}/workflow-executions` requires a user
session with `read_workspace_data` in that workspace. It returns stable cursor
pagination, current open and attention counts, and bounded state, origin,
workflow, issue, and search filters. External-integration credentials cannot use
this workspace-wide route.

Normal users receive provenance on exact execution responses. The existing
external-integration representation remains restricted and does not gain the
browser provenance projection.

Issue list and detail controllers fetch activity for all returned issue IDs in
one grouped query. They attach `workflowActivity` only for browser users and
never issue one execution query per issue.

## Trigger Pointers

Schedules and event triggers store the latest successful execution and root-run
identifiers separately from dispatch status and error. A failed, rejected,
skipped, or auto-paused dispatch updates dispatch facts but preserves those
successful pointers.

Public schedule and trigger responses resolve the pointer to a compact execution
summary. Configuration state, last dispatch outcome, and current execution
status therefore remain distinct.

## Query and Durability Rules

- Workspace ordering is `created_at DESC, id DESC`; cursors include both values
  and the filter signature.
- Workspace/status and workspace/source indexes support ledger and issue reads.
- Open means any status other than completed, failed, or cancelled.
- Attention means waiting for approval or needs review.
- The aggregate execution status is authoritative.
- Source labels come from the immutable snapshot, not a live join to trigger
  configuration.

Repository tests cover workspace isolation, counts, filtering, stable
pagination, issue summaries, provenance sanitization, schedule and trigger
pointer preservation, and OpenAPI publication.
