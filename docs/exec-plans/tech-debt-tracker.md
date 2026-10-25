# Control Plane Tech Debt Tracker

| Item | Impact | Next Action | Status |
| --- | --- | --- | --- |
| Broaden auth regression suite | Medium | Add end-to-end OIDC callback/linking coverage with provider claim fixtures | Open |
| No consumer-driven cross-repo contract replay tests | Medium | Add end-to-end contract fixtures for management-console, execution-engine, and gateway consumers | Open |
| Zod 3 collection-error amplification (GHSA-mrhx-c7xc-m3w5) | High; release gate | Add fatal raw collection limits before parsing, or migrate to patched Zod 4 with schema/converter and explicit collection-limit regressions. Byte limits and `.max()` alone are insufficient. | Open; reproduced in actual VM registration schema |
| Nodemailer runtime advisories | High dependency finding; current simple-mailbox/single-transport path has no identified matching trigger | Qualify 10.1.4 with types, auth-email regressions, and local SMTP send; no forced broad dependency update. | Open |
