---
name: acornops-control-plane-google-style
description: Apply Google TypeScript and JavaScript style guidance to the Node.js control-plane codebase. Use when editing routes, controllers, services, persistence modules, or runtime configuration code.
---

# Inputs

- changed TypeScript files under `src/`
- API contract and architecture boundaries
- existing type and naming conventions

# Procedure

1. Follow Google TypeScript style priorities: readability, explicit naming, strong typing, and small focused units.
2. Keep route/controller/service boundaries clear and avoid mixing responsibilities.
3. Prefer explicit types for externally visible values and API payload transformations.
4. Keep error messages actionable and logging structured.
5. Run repository style and type checks.

# Outputs

- style and readability review notes
- list of naming/type cleanup changes
- check results (`npm run style:check`, `npm run typecheck`)
