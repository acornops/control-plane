import { z } from 'zod';

const mutableEntryStatusSchema = z.enum(['active', 'pending']);
const tagsSchema = z.array(z.string().trim().min(1).max(80)).max(32);
const metadataSchema = z.record(z.unknown());

const mutableFields = {
  title: z.string().trim().min(1).max(240).optional(),
  status: mutableEntryStatusSchema.optional(),
  bodyMarkdown: z.string().trim().min(1).max(32768).optional(),
  tags: tagsSchema.optional(),
  evidenceSummary: z.string().trim().min(1).max(4096).optional(),
  observationCount: z.number().int().min(0).max(100_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  signals: metadataSchema.optional(),
  scope: metadataSchema.optional()
};

const createPatchSchema = z.object({
  action: z.literal('create'),
  title: z.string().trim().min(1).max(240),
  status: mutableEntryStatusSchema.optional(),
  bodyMarkdown: z.string().trim().min(1).max(32768),
  tags: tagsSchema.optional(),
  evidenceSummary: z.string().trim().min(1).max(4096).optional(),
  observationCount: z.number().int().min(0).max(100_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  signals: metadataSchema.optional(),
  scope: metadataSchema.optional()
}).strict();

const updatePatchSchema = z.object({
  action: z.literal('update'),
  entryId: z.string().trim().min(1).max(200),
  ...mutableFields
}).strict().refine(
  (patch) => Object.keys(mutableFields).some((field) => patch[field as keyof typeof patch] !== undefined),
  { message: 'An update patch must include at least one mutable field.' }
);

const archivePatchSchema = z.object({
  action: z.literal('archive'),
  entryId: z.string().trim().min(1).max(200)
}).strict();

export const TARGET_INSIGHTS_NOOP_REASON_CODES = [
  'no_durable_learning',
  'insufficient_evidence',
  'already_captured'
] as const;

const noopPatchSchema = z.object({
  action: z.literal('noop'),
  reasonCode: z.enum(TARGET_INSIGHTS_NOOP_REASON_CODES)
}).strict();

const mutationPatchSchema = z.union([createPatchSchema, updatePatchSchema, archivePatchSchema]);
const responseSchema = z.object({
  patches: z.array(z.union([mutationPatchSchema, noopPatchSchema])).min(1).max(8)
}).strict();

export type TargetInsightMutationPatch = z.infer<typeof mutationPatchSchema>;
export type TargetInsightsNoopReasonCode = typeof TARGET_INSIGHTS_NOOP_REASON_CODES[number];
export type TargetInsightsCheckpointResponseReason =
  | 'empty_response'
  | 'invalid_json'
  | 'invalid_schema'
  | 'mixed_noop'
  | 'unknown_entry';

export type TargetInsightsCheckpointDecision =
  | { kind: 'noop'; reasonCode: TargetInsightsNoopReasonCode }
  | { kind: 'patches'; patches: TargetInsightMutationPatch[] };

export type TargetInsightsCheckpointResponse =
  | { ok: true; decision: TargetInsightsCheckpointDecision; proposedPatchCount: number }
  | { ok: false; reasonCode: TargetInsightsCheckpointResponseReason; proposedPatchCount: number };

function proposedPatchCount(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const patches = (value as { patches?: unknown }).patches;
  return Array.isArray(patches) ? Math.min(patches.length, 8) : 0;
}

export function parseTargetInsightsCheckpointResponse(
  text: string,
  existingEntryIds: ReadonlySet<string>
): TargetInsightsCheckpointResponse {
  if (!text.trim()) {
    return { ok: false, reasonCode: 'empty_response', proposedPatchCount: 0 };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reasonCode: 'invalid_json', proposedPatchCount: 0 };
  }

  const count = proposedPatchCount(value);
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reasonCode: 'invalid_schema', proposedPatchCount: count };
  }

  const noopPatches = parsed.data.patches.filter((patch) => patch.action === 'noop');
  if (noopPatches.length > 0) {
    if (parsed.data.patches.length !== 1) {
      return { ok: false, reasonCode: 'mixed_noop', proposedPatchCount: count };
    }
    return {
      ok: true,
      decision: { kind: 'noop', reasonCode: noopPatches[0].reasonCode },
      proposedPatchCount: 1
    };
  }

  const patches = parsed.data.patches as TargetInsightMutationPatch[];
  if (patches.some((patch) =>
    (patch.action === 'update' || patch.action === 'archive') && !existingEntryIds.has(patch.entryId)
  )) {
    return { ok: false, reasonCode: 'unknown_entry', proposedPatchCount: count };
  }

  return {
    ok: true,
    decision: { kind: 'patches', patches },
    proposedPatchCount: patches.length
  };
}
