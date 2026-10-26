# Agent maintenance standardization

## Release integration — 2026-10-26

Implementation and independent review are complete. The user subsequently
authorized main integration and a demo release. The original implementation
record below is historical; publication and deployment acceptance are tracked
in the deployment repository's security-maintenance-release plan. Remaining
production gates are not cleared by this source qualification.

Add credential-preserving Kubernetes repair instructions and explicit maintenance
UX in Management Console. No migrations, credential-protocol changes, deployment,
or release are included. Existing runtime-validation security changes are retained.

Branch: `fix/runtime-validation-security` (existing current checkout).

The new GET requires target access and `manage_targets`; rotation remains a
separate `manage_agent_keys` operation. Deploy the API before the console. AgentK's
chart adds managed-key rollout checksums; externally managed Secrets remain owned
by the operator.

Validation on 2026-10-26: `npm run validate` passed with 1,358 tests and no skips,
using a migrated disposable PostgreSQL database and isolated Redis. Migration SQL
upgrade, authorization, OpenAPI, contract, harness, type/style, and build checks
passed. Builder/controller regressions cover authorization, no side effects,
shell quoting, version selection, value preservation, and rollout instructions.
Independent review confirmed the endpoint and builder behavior and independently
passed the 17 maintenance/install tests. No backend findings were raised. Changes
remain uncommitted; no command was run against a real cluster.
