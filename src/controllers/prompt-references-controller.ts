import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { promptResourceRegistry, PromptResourceProviderError } from '../services/prompt-resources/index.js';
import { getWorkflowDefinition } from '../store/repository-workflows.js';
import {
  parseWorkflowTemplate,
  workflowTemplateResourceCardinalityBlockers
} from '../services/workflow-template.js';
import { parseBoundedLimit } from '../utils/pagination.js';
import { toSingleParam } from '../utils/params.js';

const promptResourceRequirementSchema = z.object({
  type: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  minimum: z.number().int().min(0),
  maximum: z.number().int().min(0).max(64),
  requiredOperations: z.array(z.string().trim().min(1)),
  constraints: z.record(z.unknown()).optional()
}).strict().refine((value) => value.maximum >= value.minimum, 'maximum must be greater than or equal to minimum');

const promptReferenceResolveBodySchema = z.object({
  prompt: z.string().max(32_768),
  workflowId: z.string().trim().min(1).optional(),
  requirements: z.array(promptResourceRequirementSchema).optional()
}).strict();

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function suggestionOffset(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (!/^\d{1,4}$/.test(decoded)) return null;
    const offset = Number(decoded);
    return offset <= 1_000 && Buffer.from(decoded).toString('base64url') === value ? offset : null;
  } catch { return null; }
}

export async function listPromptReferenceTypes(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    res.status(200).json({ items: promptResourceRegistry.descriptors().filter((descriptor) => !descriptor.implicit) });
  } catch (error) { next(error); }
}

export async function suggestPromptReferences(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    const type = stringValue(req.query.type);
    if (!type) return void res.status(400).json({ error: { code: 'PROMPT_REFERENCE_TYPE_REQUIRED', message: 'type is required.', retryable: false } });
    const offset = suggestionOffset(req.query.cursor);
    if (offset === null) return void res.status(400).json({ error: { code: 'INVALID_CURSOR', message: 'cursor is invalid.', retryable: false } });
    const limit = parseBoundedLimit(req.query.limit, 20, 50);
    const workflowId = stringValue(req.query.workflowId);
    const workflow = workflowId ? await getWorkflowDefinition(workspaceId, workflowId) : null;
    if (workflowId && !workflow) {
      return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found.', retryable: false } });
    }
    const candidates = await promptResourceRegistry.suggest(type, {
      workspaceId,
      actorUserId: req.auth.userId,
      workflowId,
      requirements: workflow?.resourceRequirements || [],
      query: stringValue(req.query.q) || '',
      limit: offset + limit + 1
    });
    const items = candidates.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    res.status(200).json({
      items,
      ...(candidates.length > nextOffset ? { nextCursor: Buffer.from(String(nextOffset)).toString('base64url') } : {})
    });
  } catch (error) {
    if (error instanceof PromptResourceProviderError) {
      return void res.status(error.code === 'PROMPT_REFERENCE_UNKNOWN_TYPE' ? 404 : 409).json({
        error: { code: error.code, message: error.message, retryable: error.retryable }
      });
    }
    next(error);
  }
}

export async function resolvePromptReferences(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    const parsedBody = promptReferenceResolveBodySchema.safeParse(req.body);
    if (!parsedBody.success) return void res.status(400).json({ error: {
      code: 'PROMPT_REFERENCE_REQUEST_INVALID',
      message: parsedBody.error.issues[0]?.message || 'Prompt reference request is invalid.',
      retryable: false
    } });
    const body = parsedBody.data;
    const prompt = body.prompt;
    const template = parseWorkflowTemplate(prompt);
    if (template.errors.length > 0) {
      return void res.status(400).json({ error: {
        code: 'WORKFLOW_PROMPT_TEMPLATE_INVALID',
        message: template.errors[0]?.message || 'Workflow prompt template is invalid.',
        retryable: false,
        details: { errors: template.errors.slice(0, 64) }
      } });
    }
    const workflowId = body.workflowId;
    const workflow = workflowId ? await getWorkflowDefinition(workspaceId, workflowId) : null;
    if (workflowId && !workflow) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found.', retryable: false } });
    const requirements = workflow?.resourceRequirements || body.requirements || [];
    const result = await promptResourceRegistry.resolve(prompt, {
      workspaceId,
      actorUserId: req.auth.userId,
      workflowId,
      mode: 'authoring',
      requirements
    }, {
      enforceCardinality: false,
      includeImplicit: false
    });
    const cardinalityBlockers = workflowTemplateResourceCardinalityBlockers({
      parameters: template.parameters,
      concreteBindings: result.bindings,
      requirements
    });
    res.status(200).json({
      ...result,
      blockers: [...result.blockers, ...cardinalityBlockers],
      parameters: template.parameters
    });
  } catch (error) { next(error); }
}
