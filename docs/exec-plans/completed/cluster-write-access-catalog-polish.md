# Cluster Write Access Catalog Polish

## Goal

Expose a bounded, read-only projection of the connected Kubernetes agent's
write capability so the management console can describe effective write access
without inferring it from write-confirmation policy.

## Scope

- Add `agentAccessMode` to Kubernetes cluster list and detail responses.
- Derive `read_only`, `read_write`, or `unknown` from the stored agent
  registration capabilities.
- Update the OpenAPI schema and mirrored contract manifest.
- Add focused controller coverage.

## Compatibility

The response field is additive. Consumers must treat an omitted or `unknown`
value as unavailable during mixed-version rollout.

## Validation

- Targeted normalized snapshot controller tests
- Typecheck and contract checks
- Workspace platform-contract check

## Outcome

- Kubernetes cluster list and detail responses expose the additive
  `agentAccessMode` projection.
- Focused controller tests, typecheck, build, OpenAPI checks, and the
  cross-repository contract mirror check pass.
