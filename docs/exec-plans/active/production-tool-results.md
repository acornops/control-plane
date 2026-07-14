# Production Tool Results

Preserve AgentK output schemas and artifact policies, validate bridge envelopes, store seven-day compressed redacted artifacts, enforce workspace read authorization, audit downloads, and expose compact-only run events. Completion requires migration, authz, OpenAPI, retention, redaction, and contract validation.

Implementation is complete, repository validation passes, and the strengthened Pod-only remediation gate passes 20 consecutive local model runs. Keep this plan active through the coordinated staging soak and production release gate.

Durable design: [Tool Result Artifacts](/docs/design-docs/tool-result-artifacts.md). The final production review added pre-redaction size enforcement, immutable call-ID idempotency, database constraints, expanded defense-in-depth credential redaction, explicit 409/413 behavior, and a strict 12 KiB compact-event allowlist.
