# Control Plane Core Beliefs

- The control plane is the authority for tenant, target, Kubernetes cluster, session, and run identity.
- Cross-repo contracts must be explicit, mirrored, and mechanically checked.
- Boundary parsing matters more than internal style preferences.
- Auth boundaries must stay explicit: browser, service-token, admin-token, run-JWT, and agent-key flows are distinct.
- Favor boring, inspectable abstractions that agents can reason about directly in-repo.
- Durable design decisions belong in versioned docs, not in chat history or prompt fragments.
