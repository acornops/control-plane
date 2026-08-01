# Control Plane Quality Score

Assessment date: July 26, 2026.

| Area | Score | Evidence | Main Gap |
| --- | --- | --- | --- |
| Public and internal contracts | 4/5 | Mirrored contract docs, workflow-activity schemas, manifests, repo checks, and OpenAPI coverage | No consumer-driven end-to-end contract tests across repos |
| Auth and identity flows | 4/5 | OIDC/session docs, password policy/change tests, JWKS exposure, token boundary docs | Broaden auth regression coverage for full OIDC callback/linking scenarios |
| Run orchestration | 4/5 | Bootstrap/context/events/commit paths, immutable origin capture, trigger pointers, and activity queries are documented and checked | More cross-service failure-mode coverage is still needed |
| Workflow activity reads | 4/5 | Stable pagination, workspace isolation, safe provenance, and focused Postgres tests | The console currently uses bounded polling rather than an event-driven workspace feed |
| Agent bridge | 3/5 | Handshake/snapshot/tool bridge documented and checked | No replay harness for large or degraded snapshot conditions |
| Harness knowledge base | 4/5 | AGENTS entry point, indexed docs tree, plan directories, quality/security/reliability docs | Freshness still depends on developers updating docs as features evolve |

Re-score this file when a major architectural or operational change lands.
