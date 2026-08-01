import type { AgentDefinition, AgentSkillInstallationSnapshot } from '../types/agents.js';

export interface RunSkillSnapshot {
  ref: string;
  installation: AgentSkillInstallationSnapshot;
  totalBytes: number;
}

export function resolveRunSkillSnapshots(
  agent: AgentDefinition,
  enabledSkillIds: Iterable<string>
): RunSkillSnapshot[] {
  const enabled = new Set(enabledSkillIds);
  return agent.skillInstallations
    .filter((skill) => skill.enabled && enabled.has(skill.id))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((installation, index) => ({
      ref: `skill_${index + 1}`,
      installation,
      totalBytes: installation.files.reduce(
        (total, file) => total + Buffer.byteLength(file.content, 'utf8'),
        0
      )
    }));
}
