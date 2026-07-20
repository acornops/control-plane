export type AssistantReference =
  | {
      kind: 'tool';
      id: string;
      label: string;
      description?: string;
      capability: 'read' | 'write';
      source: 'builtin' | 'mcp' | 'provider_native';
      serverId?: string;
      toolName?: string;
    }
  | {
      kind: 'skill';
      id: string;
      label: string;
      description?: string;
      source: 'manual' | 'git_import';
    };
