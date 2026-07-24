export interface VirtualMachineInstallInstructionInput {
  platformUrl: string;
  targetId: string;
  agentKey: string;
}

export function buildVirtualMachineInstallInstructions(
  input: VirtualMachineInstallInstructionInput
): string {
  return [
    'Install the AcornOps AgentV on a Linux/systemd host:',
    '',
    '```bash',
    'sudo install -d -m 0750 -o root -g root /etc/acornops',
    "sudo tee /etc/acornops/agentv.env >/dev/null <<'EOF'",
    `ACORNOPS_AGENT_PLATFORM_URL=${input.platformUrl}`,
    `ACORNOPS_TARGET_ID=${input.targetId}`,
    `ACORNOPS_AGENT_KEY=${input.agentKey}`,
    'ACORNOPS_AGENT_TARGET_TYPE=virtual_machine',
    'ACORNOPS_AGENT_SNAPSHOT_INTERVAL_MS=60000',
    'ACORNOPS_AGENT_MAX_SNAPSHOT_BYTES=1048576',
    'ACORNOPS_AGENT_LOG_LEVEL=info',
    'ACORNOPS_VM_OS_FAMILY=linux',
    'ACORNOPS_VM_SERVICE_MANAGER=systemd',
    'ACORNOPS_VM_ALLOWED_LOG_UNITS=acornops-agentv.service',
    'ACORNOPS_VM_COLLECTOR_MODE=live',
    'EOF',
    'sudo chown root:acornops-agent /etc/acornops/agentv.env',
    'sudo chmod 0640 /etc/acornops/agentv.env',
    'sudo systemctl enable --now acornops-agentv',
    '```',
    '',
    'The agent connects outbound only and remains read-only unless the separate local helper is explicitly enabled.'
  ].join('\n');
}
