# Target Auto-Triage

Status: Experimental

Target auto-triage is a small target-native capability for Kubernetes clusters
and virtual machines. It is configured in the target's existing Settings page
and reuses issue, target chat, run, tool, approval, cancellation, audit, and
retention behavior. It is not a Workflow trigger, a new top-level product area,
or a separate recovery-policy system.

## Product Contract

- The feature is disabled by default and is visibly marked Experimental.
- Settings are revisioned and saved as one deliberate draft. The defaults are
  warning-and-critical severity, follow-target safety, and no additional
  instructions.
- Enabling the feature or lowering its severity threshold never starts existing
  issues implicitly. An administrator must explicitly queue the current
  eligible issue lifecycles.
- If auto-triage is disabled before a queued job creates its session, re-enabling
  offers that still-active lifecycle again. The explicit start action requeues
  the same durable job rather than creating a duplicate.
- A qualifying created, reopened, or severity-escalated issue receives at most
  one automatic investigation session per lifecycle version.
- Automatic sessions use the existing target session store, route, retention,
  deletion, and deep-link behavior. The console presents them in a dedicated
  Investigations history view beside human Chats, while global chat search
  continues to span both origins.
- Investigation history uses linked issue scope, object, severity, and current
  assistant status instead of a redundant origin label. The console derives a
  bounded browser-local unseen count from existing session creation timestamps.
- Workflow issue events and webhook behavior remain independent and unchanged.

## Write Policy

Administrators request one of four modes: follow target safety, diagnose only,
ask before changes, or apply allowed changes automatically. At run start, the
control plane intersects that request with the target agent's capabilities and
the target's effective confirmation policy.

Auto-triage may be stricter than the target, but it cannot enable unsupported
write tools or bypass target-level confirmation. The resolved tool mode and
confirmation behavior are pinned to the automatic session and run. Already
started runs therefore do not change when settings are edited.

## Lifecycle and Recovery

Issue persistence evaluates eligibility independently from generic Workflow
triggers. A durable job is unique by issue ID and lifecycle version. The worker
has a dedicated timer and error boundary that does not consult the Automation
runtime mode or share a Workflow scheduler tick. Each process avoids overlapping
its own ticks; multiple replicas coordinate through expiring leases, admit no
more than two nonterminal automatic runs per target, and atomically link the
stable session and run before dispatch.
The explicit current-issue action locks the saved settings revision and all
eligible issue rows in one transaction, so a concurrent settings edit cannot
partially queue a stale selection.
Session creation also takes a shared lock on the enabled settings revision. A
worker that resolved readiness against stale settings releases its job for
fresh policy resolution instead of creating a chat after disablement or pinning
an outdated action policy.

Readiness failures remain blocked and retry with bounded backoff while the issue
is active. Backoff begins at 30 seconds and caps at 15 minutes. Repeated checks
for the same blocker do not create duplicate audit events. Recovery reuses
linked session and run IDs, including after a worker lease expires; it never
creates a replacement chat for that lifecycle. Linked run and job changes
during dispatch, pre-dispatch skipping, and issue-resolution cancellation are
committed together while the lease is still valid, so an expired worker cannot
overwrite a newer replica's recovered run state. Linked run updates also lock
the run row and require its previously observed status, so the worker cannot
downgrade a run that the execution engine has already advanced to a terminal
state. A terminal-run reconciliation sweep repairs the durable job state after
that race or a process crash.
Non-degradable MCP installation failures are detected during preflight and
reported as setup blockers; the worker does not create a chat that run bootstrap
would immediately reject.

Resolving an issue skips an unstarted job or stops its nonterminal run through
the existing cancellation path. Pending approvals expire with the system
reason, but the transcript remains visible. Reopening increments the lifecycle
version and can create a new historical episode.

Deleting an automatic chat clears the job's session reference in the same
database statement while retaining the lifecycle job, so the issue degrades to
an unavailable investigation and the deleted chat is not recreated. Retention
purging relies on the same foreign-key behavior. Deleting an issue cascades its
job and clears the retained chat's issue link.

## Shared Chat and Approvals

Automatic sessions are shared only for authenticated browser members with
`create_sessions` and the run capability required by their reply. Human
messages retain the actual author. Each reply remains constrained by the
session's pinned policy and target ceiling. Manual sessions and external
integrations keep their existing creator-only rule.

Write approvals remain target-tool approvals. The approval inbox adds the
automatic session's title, origin, and deep link while preserving the existing
decision permissions and event stream. Recent automatic activity also
participates in the existing new-chat warning.

## Security and Privacy

System-started work uses `system-auto-triage`. Individual-credential MCP tools
are omitted instead of impersonating a user or substituting credentials.
Workspace credential failures are also omitted and surfaced as degraded
readiness, while non-degradable MCP installation failures block startup.
Kickoff input is bounded and sanitized before serialization. Additional target
instructions are escaped and delimited from immutable investigation and safety
guidance so administrator text cannot close its prompt boundary.

Audits record bounded configuration changes, job transitions, session/run
creation, human actors, and approval actors. They do not record full additional
instructions, raw issue evidence, credentials, internal stack traces, or
unredacted tool arguments beyond existing approval and audit policy. Terminal
run errors are not copied verbatim into the job record.

## Operations

The worker runs inside the control-plane process and requires no deployment,
chart, or environment configuration. Per-target settings remain the only
activation gate. Low-cardinality `control_plane_auto_triage_*` metrics expose
queueing, outcomes, blockers, queue-to-start latency, runtime events, and active
runs without workspace, target, issue, session, or run ID labels. Current job
state and oldest-waiting-age gauges expose backlog growth. The target settings
response also includes a bounded active/waiting summary for the existing
Settings surface; it does not expose a mutable queue or create a new product
area.
