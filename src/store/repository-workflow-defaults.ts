import type { WorkflowDefinitionForAccess } from '../types/workflows.js';

export function defaultWorkflowDefinitions(workspaceId: string): WorkflowDefinitionForAccess[] {
  return [
    {
      id: 'cluster-triage',
      workspaceId,
      version: 3,
      source: 'system',
      templateId: 'cluster-triage',
      name: 'Cluster triage',
      description: 'Mention a Kubernetes cluster in the control message and summarize likely causes, severity, and next actions.',
      status: 'active',
      category: 'cluster-triage',
      orchestratorAgentId: 'agent-workflow-orchestrator',
      tags: ['cluster', 'triage', 'incident'],
      enabledMcpServers: ['acornops-cluster-agent'],
      enabledSkills: ['acornops-observability', 'acornops-target-boundary-design'],
      inputs: [{
        name: 'targetId',
        label: 'Kubernetes cluster',
        type: 'cluster',
        required: true,
        optionSource: 'clusters'
      }],
      requiredPermissions: ['read_workspace_data', 'create_read_only_runs'],
      policy: {
        mode: 'read_only',
        maxRuntimeSeconds: 900,
        retentionDays: 90,
        approvalRequirements: []
      },
      steps: [
        {
          id: 'collect-cluster-signals',
          title: 'Collect cluster signals',
          requiredInputs: ['targetId'],
          agentIds: ['agent-cluster-triage'],
          targetBinding: { type: 'selected_target', targetType: 'kubernetes', inputName: 'targetId' },
          enabledSkills: ['acornops-observability', 'acornops-target-boundary-design'],
          allowedMcpServers: ['acornops-cluster-agent'],
          allowedTools: ['get_resource', 'get_resource_logs', 'list_resources'],
          contextGrants: ['workspace_metadata', 'target_inventory'],
          approvalRequired: false
        }
      ],
      starterPrompt: 'Triage @cluster[Cluster name] using live built-in inventory, resource, and log evidence.'
    },
    {
      id: 'repository-operation',
      workspaceId,
      version: 1,
      source: 'system',
      templateId: 'repository-operation',
      name: 'Repository operation',
      description: 'Prepare and apply a controlled configuration change in a selected repository.',
      status: 'paused',
      category: 'git-operations',
      orchestratorAgentId: 'agent-workflow-orchestrator',
      tags: ['git', 'repository', 'operations'],
      enabledMcpServers: [],
      enabledSkills: ['acornops-cross-repo-change', 'acornops-open-pr'],
      inputs: [],
      requiredPermissions: ['read_workspace_data', 'create_read_write_runs'],
      policy: {
        mode: 'read_write',
        maxRuntimeSeconds: 1200,
        retentionDays: 90,
        approvalRequirements: ['Before creating branches or pull requests']
      },
      steps: [
        {
          id: 'inspect-repository-state',
          title: 'Inspect repository state',
          requiredInputs: [],
          agentIds: ['agent-release-coordinator'],
          enabledSkills: ['acornops-cross-repo-change'],
          allowedMcpServers: [],
          allowedTools: [],
          contextGrants: ['workspace_metadata'],
          approvalRequired: false
        },
        {
          id: 'prepare-git-change',
          title: 'Prepare Git change',
          requiredInputs: [],
          agentIds: ['agent-release-coordinator'],
          enabledSkills: ['acornops-open-pr'],
          allowedMcpServers: [],
          allowedTools: [],
          contextGrants: ['workspace_metadata'],
          approvalRequired: true,
          outputArtifacts: [{ id: 'patch-plan', type: 'patch', title: 'Repository change plan', required: true }]
        }
      ],
      starterPrompt: 'Prepare the selected repository operation and ask for approval before writing.'
    },
    {
      id: 'incident-report-pdf',
      workspaceId,
      version: 3,
      source: 'system',
      templateId: 'incident-report-pdf',
      name: 'Generate incident report from chats',
      description: 'Mention one or more incident chats in the control message and generate a PDF incident report artifact.',
      status: 'active',
      category: 'incident-review',
      orchestratorAgentId: 'agent-workflow-orchestrator',
      tags: ['incident', 'report', 'pdf'],
      enabledMcpServers: [],
      enabledSkills: ['acornops-observability'],
      inputs: [{
        name: 'chatSessionIds',
        label: 'Incident chats',
        type: 'chat_session_list',
        required: true,
        optionSource: 'chatSessions'
      }],
      requiredPermissions: ['read_workspace_data', 'create_read_only_runs'],
      policy: {
        mode: 'read_only',
        maxRuntimeSeconds: 1500,
        retentionDays: 180,
        approvalRequirements: ['Before reading selected chats']
      },
      steps: [
        {
          id: 'generate-incident-report',
          title: 'Generate incident report',
          requiredInputs: ['chatSessionIds'],
          agentIds: ['agent-incident-reporter'],
          enabledSkills: ['acornops-observability'],
          allowedMcpServers: [],
          allowedTools: ['chat.sessions.read_selected', 'reports.pdf.generate'],
          contextGrants: ['selected_chat_sessions'],
          approvalRequired: true,
          outputArtifacts: [{ id: 'incident-report', type: 'pdf', title: 'Incident report PDF', required: true }]
        }
      ],
      starterPrompt: 'Generate a PDF incident report from @chat[Incident chat title].'
    }
  ];
}
