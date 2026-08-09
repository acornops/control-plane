export interface VirtualMachineInstallInstructionInput {
  platformUrl: string;
  targetId: string;
  releaseVersion: string;
  releaseBaseUrl: string;
  enrollmentToken?: string;
  enrollmentExpiresAt?: string;
  replaceCredential?: boolean;
  policyUpdate?: boolean;
}

export interface VirtualMachineInstallInstructions {
  command: string;
  releaseVersion: string;
  bootstrapUrl: string;
  warnings: string[];
  enrollmentExpiresAt?: string;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildVirtualMachineInstallInstructions(
  input: VirtualMachineInstallInstructionInput
): VirtualMachineInstallInstructions {
  if (input.replaceCredential && !input.enrollmentToken) {
    throw new Error('AgentV credential replacement instructions require an enrollment token');
  }
  if (input.policyUpdate && !input.replaceCredential) {
    throw new Error('AgentV host policy instructions require credential replacement');
  }
  if (input.enrollmentExpiresAt && !input.enrollmentToken) {
    throw new Error('AgentV enrollment expiry requires an enrollment token');
  }
  for (const [name, value] of [['release base URL', input.releaseBaseUrl], ['platform URL', input.platformUrl]]) {
    if (value.includes("'") || value.includes('\\') || value.includes('\n') || value.includes('\r')) {
      throw new Error(`AgentV ${name} contains unsupported characters`);
    }
  }
  const releaseBaseUrl = input.releaseBaseUrl.replace(/\/+$/, '');
  const bootstrapUrl = `${releaseBaseUrl}/v${input.releaseVersion}/install-agentv.sh`;
  const command = [
    'set -o pipefail;',
    `curl -fsSL --proto '=https' --proto-redir '=https' ${shellSingleQuote(bootstrapUrl)}`,
    '| sudo bash -s --',
    `--release-base-url ${shellSingleQuote(releaseBaseUrl)}`,
    `--platform-url ${shellSingleQuote(input.platformUrl)}`,
    `--target-id ${shellSingleQuote(input.targetId)}`
  ];
  if (input.enrollmentToken) command.push(`--enrollment-token ${shellSingleQuote(input.enrollmentToken)}`);
  if (input.replaceCredential) command.push('--replace-credential');

  return {
    command: command.join(' '),
    releaseVersion: input.releaseVersion,
    bootstrapUrl,
    warnings: [
      'This command is target-bound and must be run only on the intended virtual machine.',
      ...(input.enrollmentToken
        ? ['This command contains a one-use AgentV enrollment token. Do not store, log, or share it; it becomes useless after exchange or expiry.']
        : ['This command works only on the matching VM and reuses its protected AgentV credential.']),
      ...(input.policyUpdate
        ? ['This command atomically applies the pending root-owned service allowlist and replaces the AgentV credential. The previous installation remains active unless the update commits.']
        : []),
      'It requires root access on Linux with systemd and Node.js 22 or newer installed at /usr/bin/node.'
    ],
    ...(input.enrollmentExpiresAt ? { enrollmentExpiresAt: input.enrollmentExpiresAt } : {})
  };
}
