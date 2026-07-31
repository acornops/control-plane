import type { NextFunction, Response } from 'express';
import type { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { incrementAdminMutations } from '../metrics.js';
import {
  deleteDefaultProviderCredential,
  listDefaultProviderCredentials,
  putDefaultProviderCredential
} from '../services/llm-provider-credential-client.js';
import { isSupportedLlmProvider } from '../services/llm-policy.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import type { LlmProvider } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import {
  auditAdmin,
  auditAdminMutationRequest,
  validationError
} from './admin-controller-common.js';
import { mapGatewayError } from './workspaces/common.js';

const AI_GATEWAY_UPSTREAM_MESSAGE =
  'Failed to synchronize platform AI provider defaults with llm-gateway';

function providerParam(
  req: AdminAuthenticatedRequest,
  res: Response
): LlmProvider | null {
  const provider = toSingleParam(req.params.provider);
  if (!isSupportedLlmProvider(provider)) {
    validationError(res, 'Provider must be openai, anthropic, or gemini');
    return null;
  }
  return provider;
}

function handleGatewayError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof LlmGatewayHttpError) {
    const mapped = mapGatewayError(error, {
      upstreamMessage: AI_GATEWAY_UPSTREAM_MESSAGE
    });
    res.status(mapped.status).json(mapped.body);
    return;
  }
  next(error);
}

export async function listDefaultLlmProviderCredentials(
  _req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const response = await listDefaultProviderCredentials();
    res.status(200).json(response);
  } catch (error) {
    handleGatewayError(error, res, next);
  }
}

export async function upsertDefaultLlmProviderCredential(
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const provider = providerParam(req, res);
    if (!provider) return;
    incrementAdminMutations();
    await auditAdminMutationRequest(req, {
      action: 'admin.system.llm_provider_default.update',
      subjectType: 'llm_provider',
      subjectId: provider,
      reason: req.body.reason,
      metadata: { provider }
    });
    await putDefaultProviderCredential(provider, req.body.apiKey);
    await auditAdmin(req, {
      action: 'admin.system.llm_provider_default.update',
      subjectType: 'llm_provider',
      subjectId: provider,
      reason: req.body.reason,
      metadata: { provider, configured: true }
    });
    res.status(200).json(await listDefaultProviderCredentials());
  } catch (error) {
    handleGatewayError(error, res, next);
  }
}

export async function deleteDefaultLlmProviderCredential(
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const provider = providerParam(req, res);
    if (!provider) return;
    incrementAdminMutations();
    await auditAdminMutationRequest(req, {
      action: 'admin.system.llm_provider_default.delete',
      subjectType: 'llm_provider',
      subjectId: provider,
      reason: req.body.reason,
      metadata: { provider }
    });
    await deleteDefaultProviderCredential(provider);
    await auditAdmin(req, {
      action: 'admin.system.llm_provider_default.delete',
      subjectType: 'llm_provider',
      subjectId: provider,
      reason: req.body.reason,
      metadata: { provider, configured: false }
    });
    res.status(200).json(await listDefaultProviderCredentials());
  } catch (error) {
    handleGatewayError(error, res, next);
  }
}
