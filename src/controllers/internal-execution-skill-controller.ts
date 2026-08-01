import type { NextFunction, Request, Response } from 'express';
import { resolveRunSkillSnapshots } from '../services/run-skill-snapshots.js';
import { repo } from '../store/repository.js';
import { getWorkflowRun } from '../store/repository-workflows.js';
import { toSingleParam } from '../utils/params.js';

export async function getRunSkillSnapshot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const skillRef = toSingleParam(req.params.skillRef);
    const workflowRun = await getWorkflowRun(runId);
    if (workflowRun?.executorSnapshot.role === 'specialist') {
      const skills = workflowRun.executorSnapshot.agent.skillInstallations
        .filter((skill) => skill.enabled && workflowRun.compiledAccessScope.enabledSkills.includes(skill.id))
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      const match = skillRef.match(/^skill_(\d+)$/);
      const skill = match ? skills[Number(match[1]) - 1] : undefined;
      if (!skill) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow specialist skill snapshot not found', retryable: false } });
        return;
      }
      res.status(200).json({
        skill_ref: skillRef,
        skill_id: skill.id,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        content_hash: skill.contentDigest,
        file_count: skill.files.length,
        total_bytes: skill.files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0),
        files: skill.files.map((file) => ({
          path: file.path,
          content: file.content,
          size_bytes: Buffer.byteLength(file.content, 'utf8')
        }))
      });
      return;
    }

    const agentChatRun = await repo.getRun(runId);
    if (agentChatRun?.conversationKind === 'agent_chat') {
      const skill = agentChatRun.agentSnapshot && agentChatRun.compiledAccessScope
        ? resolveRunSkillSnapshots(
            agentChatRun.agentSnapshot,
            agentChatRun.compiledAccessScope.enabledSkills
          ).find((candidate) => candidate.ref === skillRef)
        : undefined;
      if (!skill) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent chat skill snapshot not found', retryable: false } });
        return;
      }
      const { installation } = skill;
      res.status(200).json({
        skill_ref: skill.ref,
        skill_id: installation.id,
        name: installation.name,
        description: installation.description,
        source: installation.source,
        content_hash: installation.contentDigest,
        file_count: installation.files.length,
        total_bytes: skill.totalBytes,
        files: installation.files.map((file) => ({
          path: file.path,
          content: file.content,
          size_bytes: Buffer.byteLength(file.content, 'utf8')
        }))
      });
      return;
    }

    const snapshot = await repo.getRunSkillSnapshot(runId, skillRef);
    if (!snapshot) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Skill snapshot not found for run', retryable: false } });
      return;
    }
    res.status(200).json({
      skill_ref: snapshot.ref,
      skill_id: snapshot.skillId,
      name: snapshot.name,
      description: snapshot.description,
      source: snapshot.source,
      content_hash: snapshot.contentHash,
      file_count: snapshot.fileCount,
      total_bytes: snapshot.totalBytes,
      files: snapshot.files.map((file) => ({ path: file.path, content: file.content, size_bytes: file.sizeBytes }))
    });
  } catch (err) {
    next(err);
  }
}
