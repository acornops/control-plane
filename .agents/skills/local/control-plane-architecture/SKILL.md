---
name: acornops-control-plane-architecture
description: Enforce control-plane architecture, API contract, and auth/session safety rules. Use when changing routes, controllers, services, persistence logic, orchestration contracts, or OIDC/session behavior.
---

# Inputs

- changed files under `src/routes`, `src/controllers`, `src/services`, `src/store`, and auth modules
- downstream integration assumptions for execution-engine and llm-gateway
- existing `/api/v1` contract behavior

# Procedure

1. Classify changes by boundary: API, auth, orchestration, persistence.
2. Preserve route and payload compatibility unless explicitly versioned.
3. Validate auth/session flow and token semantics.
4. Check orchestration contracts with execution-engine and llm-gateway.
5. Run repository build/type/style checks.

# Outputs

- architecture compliance summary
- contract-impact list and migration notes
- required downstream coordination items
