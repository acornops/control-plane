# Control Plane Plans

Execution plans are first-class repository artifacts for work that spans multiple steps, decisions, or validation loops.

## Locations

- [Active Plans](/docs/exec-plans/active/README.md)
- [Completed Plans](/docs/exec-plans/completed/README.md)
- [Tech Debt Tracker](/docs/exec-plans/tech-debt-tracker.md)

## Rules

- Create a plan in `active/` before starting multi-step work with branching decisions or cross-repo coordination.
- Record key decisions, risks, and validation results in the plan itself.
- Move the plan to `completed/` when the work lands.
- If work leaves behind known follow-up gaps, record them in the tech debt tracker.
