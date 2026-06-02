# Control Plane Architecture Workflow

1. Review touched files under `src/routes`, `src/controllers`, `src/services`, and `src/store`.
2. Verify route signatures and payload models remain backward compatible.
3. Confirm auth middleware and OIDC configuration semantics remain correct.
4. Validate service client behavior for execution-engine and llm-gateway dependencies.
5. Run `npm run build`, `npm run typecheck`, and `npm run style:check`.
6. Capture any required consumer-facing API notes.
