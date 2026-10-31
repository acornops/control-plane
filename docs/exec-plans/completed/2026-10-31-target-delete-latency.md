# Target deletion latency implementation plan

**Goal:** Remove the measured auto-triage foreign-key scan bottleneck without changing deletion semantics.

**Approved scope:** The user requested a thorough assessment followed by a focused minimal repair. Keep hard deletion, authorization, MCP teardown, audit behavior and API responses unchanged. Background deletion is deferred.

## Assessment and design

The existing repository deletes sessions/runs before deleting a cluster, and relies on cascading target deletion for VMs. Both paths invoke `ON DELETE SET NULL` on `target_auto_triage_jobs.run_id` and `.session_id`. Neither column has a leading index. With 1,000 sessions/runs and 100,000 unrelated jobs, those checks accounted for about 99% of the 32–43 second database cleanup. Adding the two indexes reduced the same workload to about 40–50 ms.

Add `013_target_delete_indexes.sql` with ordinary B-tree indexes on these columns. Existing migrations are immutable. The runner applies each file in a transaction; do not introduce concurrent-index runner changes. Index creation blocks writes to this table while building, so document a quiet rollout window. The indexes are additive and compatible with existing application binaries.

Options considered: indexed synchronous cleanup (selected, addresses measured cause), reordered destructive cleanup (unnecessary semantic risk), and durable asynchronous deletion (larger cross-service lifecycle change, deferred).

## Tasks and verification

- [x] Add SQL migration-check coverage that fails with the current schema: both foreign-key columns must have valid usable indexes; deleting populated histories must preserve `SET NULL` and target-isolation semantics.
- [x] Run the SQL upgrade checker against disposable PostgreSQL and confirm the expected failure.
- [x] Add migration 013 and rollout documentation; run upgrade checks again, including on existing populated data.
- [x] Run the repository deletion SQL against synthetic history with the full migration chain and record execution plans.
- [x] Run `npm run validate`, review the final diff independently, and record evidence.

## Review focus

- Existing databases receive the indexes through an additive migration; baseline checksums remain unchanged.
- Non-null links, retained jobs, and unrelated targets retain their existing deletion behavior.
- Index definitions cover the actual FK lookup columns and are valid, not just correctly named.
- Migration failure does not record a completed version or partially apply changes.
- Index creation has an explicit operational lock tradeoff; no production migration is run in this task.

## Coordination and progress

Console companion: `management-console/docs/exec-plans/completed/2026-10-31-target-delete-latency.md`. Either change can ship independently; backend first is preferred. No external API or cross-service schema contract changes.

Pre-flight: no shared implementation interfaces. Existing unrelated documentation changes are preserved. Work is performed on `fix/target-delete-latency` in the existing checkouts; no dependency installation or live environment changes are required.

## Validation evidence (2026-10-31)

Base revision: `cecdcdb739053fd6acdee8c8b7aafc48c13b1c89`.
Implementation and local verification are complete; deployment remains pending.

- The populated upgrade regression failed before migration 013 because the required leading indexes were absent; after the migration it passed, including retained links and actual deletion semantics.
- `CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55463/acornops_control_plane_test npm run migrations:check` — passed the full static and SQL upgrade checks on disposable PostgreSQL 16. The checker creates and cleans its own isolated schema.
- `NODE_ENV=test DATABASE_URL=postgresql://postgres@127.0.0.1:55463/acornops_control_plane_test CONTROL_PLANE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55463/acornops_control_plane_test REDIS_URL=redis://127.0.0.1:56393/0 npm run validate` — passed; 1,519 tests, zero failures/skips, plus type/style, migration static checks, authorization, membership, run events, contracts, OpenAPI, harness and build gates. The first sandbox-only baseline attempt could not bind/connect local services; this successful run used explicitly isolated PostgreSQL/Redis services.
- `NODE_ENV=test DATABASE_URL=postgresql://postgres@127.0.0.1:55463/deletion_benchmark_test npm run db:migrate` — passed all 13 migrations on a separate disposable database. Transactional `EXPLAIN (ANALYZE, BUFFERS)` deletion checks used the repository's cluster/VM SQL with 1,000 sessions/runs per target and 100,000 unrelated completed triage jobs.
- `git diff --check` — passed. Independent review found no remaining backend issues.

| Synthetic database workload | Historical schema, before indexes | Same schema, two indexes added | Full current migration chain |
| --- | ---: | ---: | ---: |
| VM with history | 42,731.920 ms | 39.766 ms | 22.394 ms |
| Cluster session cascade | 32,236.858 ms | 48.801 ms | 20.479 ms |
| Cluster final target delete | 7.577 ms | 2.559 ms | 0.791 ms |

These are controlled SQL measurements, not end-to-end latency or proof of the reported customer incident. No affected deployment ID, version SHA, or request trace was available. The full-chain benchmark additionally confirms the fix works with current migrations; timing variation between runs is expected.

## Rollout and remaining limits

Pre-merge review found that the CI job only ran static migration checks. The job
now supplies `CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL` using its existing
disposable PostgreSQL service, so populated migration checks run on every full
CI validation. The same isolated-schema check passed again locally with
PostgreSQL 16 and Node 22. Independent review found no runtime migration defect.

PR: https://github.com/acornops/control-plane/pull/31. Source qualification is
complete; applying the migration remains a separate rollout action.

Apply the normal forward migration during a quiet maintenance window; index creation temporarily blocks writes to the triage table. See [Database migrations](../../database-migrations.md). Either application binary can run with these additive indexes. No customer/demo environment was modified.

MCP teardown and audit persistence remain synchronous and can still delay an API response. End-to-end near-instant deletion is therefore not guaranteed. A customer request trace should separate gateway, SQL, audit and browser completion time before expanding this patch. No contract/platform integration check or live deployment test was run because those paths and external contracts did not change.
