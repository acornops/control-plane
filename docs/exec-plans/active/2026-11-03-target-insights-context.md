# Target Insights context role repair

## Cause and scope

After checkpoint generation resumed, relevant Target Insights could be retrieved
for Kubernetes and VM triage. The context producer prepended this evidence as a
`system` message, while the unchanged Execution Engine context contract permits
only `user` and `assistant`. A retrieval miss avoids the invalid message, so an
ordinary conversation can work while focused issue triage fails.

Restore that existing contract at the Control Plane producer. Keep retrieved
evidence in the conversation at user priority, explicitly identify it as
untrusted reference data, and preserve snippet metadata and conversation order.
Do not broaden the Engine's trusted instruction boundary or disable Insights.

## Steps

- [ ] Reproduce the retrieval-hit failure for Kubernetes and VM contexts.
- [ ] Add the minimal producer correction and role typing; verify hit and miss
  cases plus the real Engine context/transcript consumer.
- [ ] Run canonical validation, cross-service integration and independent review.
- [ ] Merge/push current-main source, publish a fresh Control Plane image and
  update only the demo Control Plane pin through the normal deployment workflow.
- [ ] Verify deployed provenance, retained state and Kubernetes/VM context reads.

User authorized main pushes, a new release and demo rollout. Existing unrelated
drafts in main checkouts remain untouched. Deployment evidence and exact command
results will be recorded under `/private/tmp/acornops-triage-context-20261103`.
