# Active Execution Plans

- [Remove Automation Rollout Mode](2026-10-31-remove-automation-rollout.md) — Default dispatch, preserved maintenance controls, and coordinated deployment cleanup.
- [Capacity Maintenance Status Fix](2026-10-31-capacity-maintenance-status.md) — Atomic workflow summaries and bounded repair of historical maintenance failures.

Reviewed 2026-10-18. Implementation-only plans that have landed are in
[Completed plans](../completed/README.md). Historical validation results are not fresh release acceptance.

- [Production Tool Results](production-tool-results.md) — Implementation complete; coordinated staging soak and production release acceptance still pending.
- [Terminal-safe Dispatch Recovery](2026-10-30-terminal-safe-dispatch-recovery.md) — Atomic, claim-fenced recovery implemented and validated on PostgreSQL; live rollout canary remains pending.
- [Structured Log Redaction](../../../../agentk/docs/exec-plans/active/2026-10-30-structured-log-redaction.md) — AgentK-owned cross-repository implementation record; independent artifact-string protection validated, coordinated rollout pending.

- [Admin console scaling](2026-11-01-admin-console-scaling.md) — Coordinated bounded directory reads; integration pending.
- [http-parser-log-protection](2026-11-01-http-parser-log-protection.md) — Implementation verified; awaiting integration.

- [VM connection status repair](vm-connection-status-repair.md) — Design gate; shared ownership/liveness and rollout contract required before outage repair implementation.

