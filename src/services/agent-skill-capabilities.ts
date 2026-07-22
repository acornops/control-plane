import { listAgentSkills } from '../store/repository-agent-skills.js';
import { updateAgentSkillCapabilitySnapshot } from '../store/repository-agents.js';

export async function syncAgentSkillCapabilitySnapshot(workspaceId: string, agentId: string) {
  const installations = await listAgentSkills(workspaceId, agentId);
  const agent = await updateAgentSkillCapabilitySnapshot(
    workspaceId,
    agentId,
    installations.filter((skill) => skill.enabled).map((skill) => skill.id),
    installations
  );
  return { agent, installations };
}
