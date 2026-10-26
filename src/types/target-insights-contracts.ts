import { z } from 'zod';

const targetInsightsStatusSchema = z.enum(['active', 'pending', 'archived']);

export const createTargetInsightsEntrySchema = z.object({
  title: z.string().trim().min(1).max(240),
  status: targetInsightsStatusSchema.default('active'),
  bodyMarkdown: z.string().max(32768),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(32).optional(),
  signals: z.record(z.string(), z.unknown()).optional(),
  scope: z.record(z.string(), z.unknown()).optional(),
  evidenceSummary: z.string().max(4096).optional(),
  observationCount: z.number().int().min(0).max(100000).optional(),
  confidence: z.number().min(0).max(1).optional()
}).strict();

// Creation's default must not reactivate an entry during an unrelated update.
export const updateTargetInsightsEntrySchema = createTargetInsightsEntrySchema.partial()
  .extend({ status: targetInsightsStatusSchema.optional() }).strict().refine(
  (input) => Object.keys(input).length > 0,
  { message: 'at least one field is required' }
);
