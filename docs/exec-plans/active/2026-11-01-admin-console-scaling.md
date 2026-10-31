# Admin console scaling implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task.

**Goal:** Preserve admin totals, filters, and membership actions without downloading the platform catalog.
**Architecture:** Add bounded workspace and user summary responses under their existing read scopes. Filter workspace lifecycle in SQL. Use existing cursor search for grant candidates and suggestions; include workspace display context in user membership detail.
**Tech Stack:** PostgreSQL, Express/TypeScript, React, fixed Node BFF, existing Playwright checks.
**Spec:** Accepted minimal scaling scope below; coordinated with platform-admin-console on `fix/admin-console-scaling`.

## Accepted scope and global constraints

- Preserve exact governance totals, top-three connected workspaces, user verification signals, full-catalog workspace count, status filters, and existing membership payloads.
- Add `GET /admin/v1/workspaces/summary` and `GET /admin/v1/users/summary`, guarded by `admin:workspace:read` and `admin:user:read` respectively. Return only counts and up to three workspace identity/count rows.
- Add optional `lifecycleStatus=active|suspended` to workspace search and bind it to the cursor signature.
- Add workspace name/lifecycle fields to existing user memberships, avoiding full workspace lookups for display. No tenant operational data is returned.
- Console selectors use 25-row search pages and explicit Load more; suggestions use a bounded page. Workspace member reads remain scoped to the selected workspace.
- No database migration, cache, new dependency, mutation changes, or visual redesign.
- Preserve REQ-OVR-001, REQ-WSP-001, REQ-USR-001/007/009 user behavior; replace their full-catalog transport implementation. Producer deploys before consumer; rollback the consumer first.

## Review focus

- Empty catalogs produce zero totals and no leaders; missing summary responses must not masquerade as zero.
- Status-filtered pages remain complete, bounded, duplicate-free, and reject cursors from another filter.
- Summary endpoints retain narrow authorization and BFF projections.
- Searching or paging candidates cannot silently lose an eligible recipient or grant an existing membership.
- Obsolete candidate/suggestion responses are ignored, and user details retain workspace names/status without a platform catalog request.

## Task 1: Add bounded producer reads

**Files:** new admin summary store/controller and tests, admin route/controller/workspace/user store files, OpenAPI and manifests.
**Interfaces:** Workspace summary returns `workspaceCount`, `suspendedWorkspaceCount`, `kubernetesCount`, `virtualMachineCount`, `environmentLeaders` (id, name, clusterCount, virtualMachineCount). User summary returns `userCount`, `verifiedUserCount`.

- [x] Add failing HTTP/PostgreSQL tests for summaries, empty tables, 137 filtered workspaces across pages, cursor mismatch, and denied scopes.
- [x] Implement the two aggregate reads, additive filters/context, and explicit contracts.
- [x] Run targeted PostgreSQL tests and `npm run validate` against task-owned disposable databases.
- [x] Commit producer changes independently as `perf: add bounded admin governance summaries`.

## Task 2: Consume bounded reads

**Files:** console API projection/policy/mocks, Overview/Workspaces/Users pages, a focused directory selector, requirements/contracts, browser and BFF tests.
**Interfaces:** Same-origin summary paths mirror producer paths; existing list and mutation routes remain in use.

- [x] Add failing browser checks proving overview does not fetch directories, status filters use cursor pages, details open without user catalog discovery, and grant/search can reach later pages.
- [x] Wire summaries and status query; replace global grant and suggestion catalogs with bounded searches and membership display context.
- [x] Update producer/consumer manifest together, requirement evidence and design notes.
- [x] Run console validation, privacy/denial tests, browser reliability/directory/scaling checks, and workspace contract comparison.
- [x] Commit consumer changes as `perf: bound admin directory loading`; review all four changes before integration.


## Review and validation record

- A fresh independent review found no blocking correctness or privacy issue. Its
  workspace-ID suggestion finding was accepted: the producer and mock now search
  names or IDs. The PostgreSQL assertion failed before the query change and
  passed after it; the browser ID-suggestion case also failed before the mock
  correction and passed afterward.
- Real PostgreSQL fixtures exercise 1,000 users/workspaces and 137 suspended
  workspaces/members across cursor pages. They exposed precision loss in the old
  JavaScript-date cursor; the narrow fix preserves the raw database timestamp
  for workspace/user/member cursors. Empty and zero-footprint catalogs pass.
- Console `npm run validate` passes 113 tests plus contracts, requirements,
  harness, build and smoke checks. Seven new scaling browser cases, four detail
  reliability cases, and 14 existing directory/grant cases pass. Existing grant
  assertions now wait for candidates loaded when the dialog opens; deliberate
  recipient/role selection and all original mutation assertions remain.
- A local `ADMIN_CONSOLE_DATA_MODE=control-plane` probe exercised the actual BFF,
  producer handlers and the populated PostgreSQL fixture together: exact counts,
  bounded lifecycle pages, membership labels, no-store responses, dropped
  session fields and query denial passed. Cross-repository manifests match.
- The admin OpenAPI line budget increases from 5,400 to 5,600 only to accommodate
  the two explicit additive endpoints and their bounded response schemas; public
  API budgets and source-file budgets remain unchanged.
- Desktop/mobile grant screenshots in light and dark themes were captured by the
  existing browser checks; mobile light and desktop dark were visually inspected.

Review limits: exact aggregate query latency was not benchmarked on production
catalogs; responses are bounded but counting still reads catalog rows. Equal-count
leader ties now use database name ordering rather than browser locale ordering.
Concurrent membership mutations retain the existing authoritative producer checks.
These limits do not require a new cache, schema or mutation protocol in this fix.
Producer deploys first; console reliability merges before the scaling consumer.


The second producer full run encountered PostgreSQL deadlock `40P01` while a
parallel integration probe held fixture schema locks. The affected existing
AgentV test passed in isolation; the final full run uses the database exclusively.
This was validation-fixture contention, not an AgentV source change.


Final producer `npm run validate`: passed, 1,615 tests with no failures or skips,
plus type/style, migration, authorization, membership, run-event, contract,
OpenAPI, harness and build checks. The sibling docs-website inventory check was
rerun with the canonical checkout linked and passed. Implementation and review
are complete; merge and deployment remain separate.
