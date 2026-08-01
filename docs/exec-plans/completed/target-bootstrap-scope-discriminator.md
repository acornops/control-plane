# Target bootstrap scope discriminator

Status: completed 2026-08-02

## Goal

Restore compatibility between control-plane target-run bootstrap snapshots and
the execution engine's explicit discriminated scope contract.

## Completed work

1. Target-run bootstrap now emits `scope.type=target` alongside its exact
   workspace, target, session, run, and user identity.
2. The focused controller regression test asserts the complete target scope.
3. The contract checker now verifies the `target`, `agent_chat`, and
   `workspace` discriminators in their respective bootstrap producers.
4. Existing mirrored contract manifests already documented `scope.type`, so no
   consumer schema or manifest change was required.

## Validation results

- Focused internal execution controller suite: 9 tests passed.
- Full control-plane validation: 1,100 tests passed; type, style, migration
  static checks, authorization, membership, run-event durability, contracts,
  OpenAPI, harness, and build all passed.
- Workspace cross-repository contract checks passed.
- The running local control plane returned `type=target` for the previously
  failed run, and the running execution engine accepted the complete response
  with `ExecutionSnapshot.model_validate`.

## Outcome

Target assistant runs no longer fail bootstrap with Pydantic
`union_tag_not_found`, while Agent-chat and Workflow scopes retain their strict
explicit discriminators.
