# Workspace execution capacity

AcornOps remains independently self-hostable. An optional controller uses scoped
admin APIs to assign configured plans or manage its own external suspension hold.
It does not need database access. Commercial policy belongs outside AcornOps.

## Policy and classification

Plans configure five independent pairs of concurrent/outstanding limits: `chat`,
`agent`, `workflow`, `autoTriage` and `insights`. Both values are positive integers
with outstanding at least concurrent, or both null. Omitted pools are unlimited.
There is no aggregate cap or borrowing. Workflow children always use Workflow;
auto-triage reserves before creating its conversation and never consumes Chat.
Insights reserves only when a persisted checkpoint attempt is ready for model work.
A newer activity marker detaches the superseded attempt; stale output cannot apply.

Policy writes lock the workspace, resolve request replay before version/usage
preconditions and atomically commit the policy, success audit and receipt.
Resource overrides survive plan changes. Explicit `retain_existing` downgrades
retain resources and admitted work while new work observes the lower limits.
Receipts are retained for 30 days; requests with an idempotency ID always require
an expected policy version, including callers using broad legacy scopes.

Administrative and external holds are independent. Either blocks workload access.
Only safe identity and public reason fields appear in member access-state APIs.
Suspension writes durable cancellation intent; clearing a hold cannot erase it.
Restoration admits new work and never replays attempts cancelled by suspension.

## Runtime authority

Admission and its outstanding reservation commit together under a workspace lock.
Conversation delivery uses a PostgreSQL outbox; auto-triage retains its own durable,
eligibility-aware job. Approval resumes rearm delivery atomically. An engine HTTP
acknowledgement is delivery acceptance; `run_started` establishes running state.

PostgreSQL grants bind a run, worker owner and generation. New provider/tool
operations validate that authority at actual dispatch. Expired leases cannot be
reacquired as new execution. Existing operation records retain concurrent capacity
until completion or their bounded deadline; uncertainty never authorizes an
automatic retry of a write. Cleanup uses the original owner/generation.

Control-plane native tools use the same authority. Document creation validates
lifecycle, durable suspension cancellation and current ownership under the
workspace lock in the same transaction as its insert. Fetch begins its bounded
operation after DNS resolution and immediately before the HTTP request, then
finishes it after request cleanup. Both native entrypoints retain the caller's
original owner/generation through asynchronous lookups. Lifecycle and cancellation
checks still apply when capacity limits are disabled.

Approval waits retain outstanding capacity with their existing expiry policy;
approval resolution starts a fresh eligible queue interval once. Dependency waits
persist the coordinator transcript and pending tool call before releasing both
execution gates. Child settlement redispatches that same attempt. Resume consumes
the checkpoint without repeating earlier writes or delegation creation.

Maintenance reconciles cancellation, expired authority, terminal reservations,
superseded Insights attempts, receipts and durable redispatch every ten seconds.
Suspension checks remain active when capacity limits are disabled. Admission and
dispatch gates support quiesced upgrades; stopping dispatch still permits cleanup.

## Deployment and verification

Follow the deployment repository's `docs/hosted-readiness.md` for compatible
replica rollout, retained-attempt backfill, verification, activation and rollback.
`npm run capacity:rollout` runs the compiled CLI, which is available in production
images after the normal build. Keep all ledgers and cancellation evidence.

`npm run validate` includes PostgreSQL policy, capacity, continuation, Insights,
rollout and dispatch regression tests. Set `NODE_ENV=test`, `DATABASE_URL` and
`CONTROL_PLANE_TEST_DATABASE_URL` to the same disposable test database, and point
`REDIS_URL` at disposable Redis. Apply all migrations first.

The explicit replica probe additionally needs the sibling execution-engine's
Python virtual environment and dependencies:

```sh
node --import tsx test/integration/capacity-replicas.ts
```

It resets the test workspace fixtures and starts two loopback control-plane HTTP
processes and two real Redis-backed engine workers. Its deterministic operation
body replaces model/tool work; production HTTP authority, event/commit routes,
PostgreSQL locks, engine scheduling and Redis durability remain real. Gateway
provider/MCP dispatch fencing is covered by the gateway's separate boundary tests.
No live provider key is needed.
