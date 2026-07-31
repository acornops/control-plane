# Default target Agents

## Goal

Replace the reporting-oriented starter Agent pair with one Kubernetes Agent and
one Virtual Machine Agent. Give each Agent the complete currently supported
built-in target-tool ceiling for its target type, and rewire the existing
starter Workflows without rewriting those Workflow prompts yet.

## Decisions

- Built-in target MCP servers remain target-owned. The starter Agents receive
  semantic capabilities and exact target scopes; live target discovery keeps
  the corresponding server and all advertised tools enabled and creates the
  per-target routing mappings.
- Kubernetes receives read and approval-gated write capabilities. Virtual
  machines receive the complete current AgentV ceiling, which is read-only.
- Both Agents retain the native prompt-resource and PDF tools needed by the
  existing reporting Workflows until those Workflows are redesigned. Target-
  routed Workflows select both Agents; Kubernetes-only remediation and the
  targetless report Workflow stay direct so their current runtime semantics
  continue to work.
- Existing workspace-owned Agent records are not overwritten. The new starter
  set applies to newly provisioned workspaces and explicit future template
  installs.

## Work

- [x] Replace the starter Agent definitions and rewire all starter Workflows.
- [x] Update lifecycle and provisioning coverage.
- [x] Align management-console fixtures and public documentation.
- [x] Run targeted and repository validation.

## Validation

- Starter template and development provisioning tests: 3 passed.
- PostgreSQL-backed Workflow and Agent template foundations: 5 passed against
  a disposable database, which was removed after validation.
- Control-plane typecheck, style, build, migration static checks,
  authorization, membership, run-event durability, contracts, and harness:
  passed.
- Workspace runtime-truth check: passed.
- Management-console fixture router: 8 passed. UI package typecheck passed.
- Public documentation check, build validation, and link check: passed.
- Full control-plane validation was invoked but not completed after the
  unrelated platform-admin MFA policy test failed under the running local
  container configuration. The changed starter tests passed in that run.
- Existing unrelated blockers remain: the public OpenAPI document exceeds its
  checked-in line budget, and the management-console application typecheck has
  missing `resolveTargetGitSkill` and `TextInput` symbols outside this change.

## Cross-repository impact

- `management-console`: aligned mock-mode fixtures with the runtime starter set.
- `docs-website`: documented the two default target Agents and tool behavior.
