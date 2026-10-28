import type { Request, Response } from 'express';
import { z } from 'zod';
import { listCancelledRunIds } from '../store/repository-run-cancellation.js';

export const cancellationStatusSchema = z.object({
  runIds: z.array(z.string().min(1).max(200).refine((id) => id.trim() === id && id.length > 0))
    .min(1).max(100).refine((ids) => new Set(ids).size === ids.length)
}).strict();

export async function cancellationStatus(req: Request, res: Response): Promise<void> {
  res.json({ cancelledRunIds: await listCancelledRunIds(req.body.runIds) });
}
