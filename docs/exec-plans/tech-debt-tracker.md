# Control Plane Tech Debt Tracker

| Item | Impact | Next Action | Status |
| --- | --- | --- | --- |
| Capacity maintenance leaves stale Workflow execution status | High; expired runs can appear queued indefinitely and block resume | Atomic maintenance transitions and bounded historical reconciliation; see [repair](active/2026-10-31-capacity-maintenance-status.md). | Implemented and validated; coordinated release tracked in PR #32 |
| Broaden auth regression suite | Medium | Add end-to-end OIDC callback/linking coverage with provider claim fixtures | Open |
| No consumer-driven cross-repo contract replay tests | Medium | Add end-to-end contract fixtures for management-console, execution-engine, and gateway consumers | Open |
| Zod 3 collection-error amplification (GHSA-mrhx-c7xc-m3w5) | High dependency finding | Zod 4.6.7 with early bounded-array rejection and compatibility regressions; see [qualification](active/runtime-validation-security.md). Release patched artifacts before promotion. | Implemented and reviewed locally; publication pending |
| Nodemailer runtime advisories | High dependency finding | 10.1.4 with bundled types and real loopback SMTP delivery/auth/rejection/TLS tests; see [qualification](active/runtime-validation-security.md). | Implemented and reviewed locally; publication pending |
| Unconstrained collection validation | Webhook exposure fixed; other public records remain a separate audit | Webhook catalog bound, bounded diagnostics and authorization-before-validation implemented. Audit other open records separately. | Webhook fixed; remaining audit open |
| Hard schema-validation deadlines | Protect event loops from expensive schema evaluation | Disposable bounded processes in Engine/Gateway; no inline fallback | Closed; see [validation and review](completed/2026-10-31-validation-retention.md) |
| VM status can stay online after dependency failure or process death during disconnect | Inherited Linux/Windows availability gap; no durable callback retry | [Separate repair plan](active/vm-connection-status-repair.md) requires real-store race characterization and explicit ownership/liveness/rollout before adding a recurring writer. Ordinary exact-ID disconnect remains unchanged. | Open for durable repair/events; heartbeat-based connection reporting now expires independently. Design gate remains for a recurring writer. |
