# Windows VM final catch-all: backend

Status: source implementation and review complete. Coordinated plan: [AgentV final catch-all](../../../../agentv/docs/exec-plans/completed/windows-final-catch-all.md).

Remove only the repeated Windows discovery filter after proving the gateway
already applies it; preserve dispatch and lifecycle enforcement. Remove unused
snapshot aliases. Regression: synchronization traverses the real gateway filter,
retains exactly eight read tools and performs one platform lookup (previously two).
Run affected tests and full validation against isolated PostgreSQL/Redis.

Final local `npm run validate` passes 1,769 tests/259 suites, zero failures/skips,
with isolated PostgreSQL16/Redis7 and all type/style/migration/authz/membership/
event/contracts/OpenAPI/harness/build gates. Required integration-profile build
and real WebSocket Linux AgentV/AgentK expiry/recovery/reconnect probes pass.
Independent coordinated review has no blocking source findings. Initial local
setup attempts failed the explicit test-database guard; the correct isolated test
URL/name passed without changing production code or weakening the guard.
Exact-revision hosted evidence is recorded on draft PR #33. No contract, schema,
migration, heartbeat projection or dispatch guard changes in this final pass.
