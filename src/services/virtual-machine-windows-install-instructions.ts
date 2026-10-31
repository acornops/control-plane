import { isSafeWindowsInstallUrl } from '../config-agentv-windows.js';
import type { VirtualMachineInstallInstructionInput, VirtualMachineInstallInstructions } from './virtual-machine-install-instructions.js';

export function buildVirtualMachineWindowsInstallInstructions(input: VirtualMachineInstallInstructionInput): VirtualMachineInstallInstructions {
  if (!isSafeWindowsInstallUrl(input.releaseBaseUrl) || !isSafeWindowsInstallUrl(input.platformUrl)) {
    throw new Error('Windows AgentV installation requires literal HTTPS URLs');
  }
  for (const value of [input.targetId, input.releaseVersion, input.enrollmentToken]) {
    if (value !== undefined && !/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Windows AgentV installation argument is invalid');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.releaseVersion)) throw new Error('Windows AgentV release must be pinned');
  if (input.replaceCredential && !input.enrollmentToken) throw new Error('Credential replacement requires an enrollment token');
  if (input.enrollmentExpiresAt && !input.enrollmentToken) throw new Error('Enrollment expiry requires an enrollment token');
  if (input.policyUpdate) throw new Error('Windows AgentV supports read-only access');
  const releaseBaseUrl = input.releaseBaseUrl.replace(/\/+$/, '');
  const bootstrapUrl = `${releaseBaseUrl}/v${input.releaseVersion}/install-agentv.ps1`;
  const args = [`-ReleaseBaseUrl '${releaseBaseUrl}'`, `-PlatformUrl '${input.platformUrl}'`, `-TargetId '${input.targetId}'`];
  if (input.enrollmentToken) args.push(`-EnrollmentToken '${input.enrollmentToken}'`);
  if (input.replaceCredential) args.push('-ReplaceCredential');
  // Resolve the operating-system executable, bypassing aliases and user PATH.
  const command = [
    "$agentvTemporaryFile = [System.IO.Path]::GetTempFileName();",
    "$agentvInstaller = $agentvTemporaryFile + '.ps1';",
    'try {',
    'Move-Item -LiteralPath $agentvTemporaryFile -Destination $agentvInstaller -ErrorAction Stop;',
    "$agentvCurl = Join-Path ([Environment]::GetFolderPath('System')) 'curl.exe';",
    `& $agentvCurl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-redirs 5 --connect-timeout 15 --max-time 60 --max-filesize 1048576 --output $agentvInstaller '${bootstrapUrl}';`,
    "if (-not $? -or $LASTEXITCODE -ne 0) { throw 'AgentV download failed' };",
    `& $agentvInstaller ${args.join(' ')};`,
    "if (-not $?) { throw 'AgentV installation failed' }",
    '} finally {',
    'Remove-Item -LiteralPath $agentvInstaller,$agentvTemporaryFile -Force -ErrorAction SilentlyContinue',
    '}'
  ].join(' ');
  return {
    command,
    releaseVersion: input.releaseVersion,
    bootstrapUrl,
    warnings: ['Run only on the intended Windows VM in an elevated PowerShell session.', ...(input.enrollmentToken ? ['Contains a one-use enrollment token; do not store, log, or share it.'] : ['Reuses the protected credential on the matching VM.'])],
    ...(input.enrollmentExpiresAt ? { enrollmentExpiresAt: input.enrollmentExpiresAt } : {})
  };
}
