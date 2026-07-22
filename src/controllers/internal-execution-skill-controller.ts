import type { NextFunction, Request, Response } from 'express';
import { getAgentActivityRecord } from '../store/repository-agents.js';
import { repo } from '../store/repository.js';
import { toSingleParam } from '../utils/params.js';

export async function getRunSkillSnapshot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const skillRef = toSingleParam(req.params.skillRef);
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

export async function getAgentRunSkillSnapshot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const run = await getAgentActivityRecord(toSingleParam(req.params.runId));
    if (!run?.agentSnapshot) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent skill snapshot not found for run', retryable: false } });
      return;
    }
    const skills = run.agentSnapshot.skillInstallations
      .filter((skill) => skill.enabled && run.compiledScope.enabledSkills.includes(skill.id))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const match = toSingleParam(req.params.skillRef).match(/^skill_(\d+)$/);
    const skill = match ? skills[Number(match[1]) - 1] : undefined;
    if (!skill) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent skill snapshot not found for run', retryable: false } });
      return;
    }
    res.status(200).json({
      skill_ref: toSingleParam(req.params.skillRef),
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
  } catch (err) { next(err); }
}
