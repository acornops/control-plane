# Deployment-owned workflow policy

Make the control plane the authority for manual workflow defaults, execution duration, report retention, and VM install URLs. Legacy per-workflow timing fields remain accepted for compatibility but are normalized to effective deployment values in responses. Validate controller defaults, option catalogs, report expiry, VM instruction safety, OpenAPI, and repository checks.

Coordinated by the parent workspace `plan.md`. Related repositories: `acornops-deployment`, `management-console`, and `docs-website`.

Completed: VM instructions now use the configured public URL and a literal heredoc; workflow defaults and effective timing are centralized; report expiry, option catalogs, OpenAPI, contracts, and focused tests use deployment configuration.
