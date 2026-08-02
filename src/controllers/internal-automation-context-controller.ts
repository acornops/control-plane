import type { NextFunction, Request, Response } from 'express';
import { getWorkflowRun } from '../store/repository-workflows.js';
import { toSingleParam } from '../utils/params.js';

export async function getWorkflowRunContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const run = await getWorkflowRun(toSingleParam(req.params.runId));
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow run not found', retryable: false } });
      return;
    }
    res.status(200).json({
      messages: [{ role: 'user', content: run.prompt }],
      summaries: [], attachments: []
    });
  } catch (err) { next(err); }
}
