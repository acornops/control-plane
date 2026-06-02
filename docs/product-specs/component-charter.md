# Control Plane Component Charter

## Responsibilities

- Authenticate users and issue durable session state.
- Manage workspaces, the shared target core, Kubernetes clusters, Linux/systemd VMs, sessions, messages, and runs.
- Dispatch execution work and persist execution state.
- Broker outbound-only target-agent connectivity.
- Publish the platform contract hub consumed by other repos.

## Non-Goals

- Direct browser-side business logic
- In-process LLM inference
- In-cluster tool execution without the k8s-agent

## Primary Consumers

- Management-console operators
- Execution-engine
- llm-gateway
- k8s-agent
- vm-agent
