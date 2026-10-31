# Active Execution Plans

Reviewed 2026-10-18. Implementation-only plans that have landed are in
[Completed plans](../completed/README.md). Historical validation results are not fresh release acceptance.

- [Production Tool Results](production-tool-results.md) — Implementation complete; coordinated staging soak and production release acceptance still pending.
- [Terminal-safe Dispatch Recovery](2026-10-30-terminal-safe-dispatch-recovery.md) — Atomic, claim-fenced recovery implemented and validated on PostgreSQL; live rollout canary remains pending.
- [Structured Log Redaction](../../../../agentk/docs/exec-plans/active/2026-10-30-structured-log-redaction.md) — AgentK-owned cross-repository implementation record; independent artifact-string protection validated, coordinated rollout pending.
