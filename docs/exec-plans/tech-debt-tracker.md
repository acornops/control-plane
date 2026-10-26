# Control Plane Tech Debt Tracker

| Item | Impact | Next Action | Status |
| --- | --- | --- | --- |
| Broaden auth regression suite | Medium | Add end-to-end OIDC callback/linking coverage with provider claim fixtures | Open |
| No consumer-driven cross-repo contract replay tests | Medium | Add end-to-end contract fixtures for management-console, execution-engine, and gateway consumers | Open |
| Zod 3 collection-error amplification (GHSA-mrhx-c7xc-m3w5) | High dependency finding | Zod 4.6.7 with early bounded-array rejection and compatibility regressions; see [qualification](active/runtime-validation-security.md). Release patched artifacts before promotion. | Implemented and reviewed locally; publication pending |
| Nodemailer runtime advisories | High dependency finding | 10.1.4 with bundled types and real loopback SMTP delivery/auth/rejection/TLS tests; see [qualification](active/runtime-validation-security.md). | Implemented and reviewed locally; publication pending |
| Unconstrained collection validation | High; release gate for public webhook validation before workspace authorization | Define early item/nesting/error budgets, starting with webhook event types and open public records; coordinate workflow/event-batch limits with consumers. Byte limits and patched Zod do not bound schemas without maxima. See the qualification's exposure table. | Open; no arbitrary limits introduced |
