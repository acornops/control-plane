import { z } from 'zod';

const knowledgeBankStatusSchema = z.enum(['active', 'pending', 'archived']);

export const createKnowledgeBankEntrySchema = z.object({
  title: z.string().trim().min(1).max(240),
  status: knowledgeBankStatusSchema.default('active'),
  bodyMarkdown: z.string().max(32768),
  frontmatter: z.record(z.unknown()).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(32).optional(),
  signals: z.record(z.unknown()).optional(),
  scope: z.record(z.unknown()).optional(),
  evidenceSummary: z.string().max(4096).optional(),
  observationCount: z.number().int().min(0).max(100000).optional(),
  confidence: z.number().min(0).max(1).optional()
}).strict();

export const updateKnowledgeBankEntrySchema = createKnowledgeBankEntrySchema.partial().strict().refine(
  (input) => Object.keys(input).length > 0,
  { message: 'at least one field is required' }
);
