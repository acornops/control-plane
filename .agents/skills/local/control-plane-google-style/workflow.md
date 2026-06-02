# Control Plane Google Style Workflow

1. Review changed files in `src/routes`, `src/controllers`, `src/services`, and `src/store`.
2. Ensure identifiers and function names are explicit and domain-aligned.
3. Remove avoidable complexity in control flow and nested conditionals.
4. Keep type usage explicit at API and persistence boundaries.
5. Run `npm run style:check` and `npm run typecheck`.
6. Record any required follow-up style cleanup outside current scope.
