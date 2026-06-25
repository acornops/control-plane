import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { createLocalJWKSet, exportJWK, jwtVerify, SignJWT, type JSONWebKeySet, type JWK, type JWTPayload } from 'jose';
import { type AppConfig, config } from '../config.js';
import { isTargetType, type TargetType, type WorkspaceAuditOperation } from '../types/domain.js';

export type RunScopeType = 'target' | 'workspace';

interface BaseRunScopeClaims {
  runId: string;
  workspaceId: string;
  sessionId: string;
  allowedProviders: string[];
  allowedTools: string[];
  allowedToolOperations?: Record<string, WorkspaceAuditOperation>;
  maxOutputTokens?: number;
  allowedModels?: string[];
}

export interface TargetRunScopeClaims extends BaseRunScopeClaims {
  scopeType?: 'target';
  targetId: string;
  targetType: TargetType;
}

export interface WorkflowRunScopeClaims extends BaseRunScopeClaims {
  scopeType: 'workspace';
  workflowId: string;
  workflowRunId: string;
  workflowSessionId: string;
  workflowStepId?: string;
  contextGrants?: string[];
  targetId?: string;
  targetType?: TargetType;
}

export type RunScopeClaims = TargetRunScopeClaims | WorkflowRunScopeClaims;

export interface VerifiedRunScopeClaims extends BaseRunScopeClaims {
  subject: string;
  tokenId?: string;
  scopeType: RunScopeType;
  targetId?: string;
  targetType?: TargetType;
  workflowId?: string;
  workflowRunId?: string;
  workflowSessionId?: string;
  workflowStepId?: string;
  contextGrants: string[];
}

interface KeyMaterial {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

interface GatewayVerificationKey extends JWK {
  kid: string;
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, '\n');
}

function configuredPrivateKeyPem(appConfig: AppConfig): string | null {
  if (appConfig.GATEWAY_SIGNING_PRIVATE_KEY_PEM) {
    return normalizePem(appConfig.GATEWAY_SIGNING_PRIVATE_KEY_PEM);
  }
  if (appConfig.GATEWAY_SIGNING_PRIVATE_KEY_PEM_B64) {
    return Buffer.from(appConfig.GATEWAY_SIGNING_PRIVATE_KEY_PEM_B64, 'base64').toString('utf8');
  }
  return null;
}

function createKeys(appConfig: AppConfig): KeyMaterial {
  const privateKeyPem = configuredPrivateKeyPem(appConfig);
  if (privateKeyPem) {
    const privateKey = createPrivateKey(privateKeyPem);
    return {
      privateKey,
      publicKey: createPublicKey(privateKey)
    };
  }
  if (appConfig.NODE_ENV === 'production') {
    throw new Error('Gateway signing private key is required in production');
  }
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001
  });
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey
  };
}

function parseVerificationKeys(appConfig: AppConfig): GatewayVerificationKey[] {
  if (!appConfig.GATEWAY_VERIFICATION_JWKS_JSON) {
    return [];
  }
  const parsed = JSON.parse(appConfig.GATEWAY_VERIFICATION_JWKS_JSON) as { keys?: unknown };
  if (!Array.isArray(parsed.keys)) {
    throw new Error('GATEWAY_VERIFICATION_JWKS_JSON must contain a keys array');
  }
  return parsed.keys.map((key) => {
    if (!key || typeof key !== 'object' || typeof (key as { kid?: unknown }).kid !== 'string') {
      throw new Error('Every verification JWKS key must be an object with a kid');
    }
    return key as GatewayVerificationKey;
  });
}

function stringClaim(payload: JWTPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Gateway token claim ${key} must be a non-empty string`);
  }
  return value;
}

function stringArrayClaim(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Gateway token permission ${key} must be a string array`);
  }
  return value;
}

function optionalStringClaim(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Gateway token claim ${key} must be a non-empty string when present`);
  }
  return value;
}

function toolOperationMapClaim(value: unknown): Record<string, WorkspaceAuditOperation> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const operations: Record<string, WorkspaceAuditOperation> = {};
  for (const [toolName, operation] of Object.entries(value as Record<string, unknown>)) {
    if (typeof toolName !== 'string' || toolName.trim().length === 0) {
      continue;
    }
    if (operation === 'read' || operation === 'write') {
      operations[toolName] = operation;
    }
  }
  return operations;
}

function parseRunScopeClaims(payload: JWTPayload): VerifiedRunScopeClaims {
  const runId = stringClaim(payload, 'run_id');
  const subject = stringClaim(payload, 'sub');
  if (subject !== `run:${runId}`) {
    throw new Error('Gateway token subject must match run_id');
  }
  const rawScope = payload.scope;
  const scopeType: RunScopeType =
    rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope) && (rawScope as { type?: unknown }).type === 'workspace'
      ? 'workspace'
      : 'target';
  const permissions = payload.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new Error('Gateway token permissions must be an object');
  }
  const permissionObject = permissions as Record<string, unknown>;
  const maxOutputTokens = permissionObject.max_output_tokens;
  if (maxOutputTokens !== null && maxOutputTokens !== undefined && typeof maxOutputTokens !== 'number') {
    throw new Error('Gateway token permission max_output_tokens must be a number or null');
  }

  const baseClaims = {
    subject,
    tokenId: typeof payload.jti === 'string' ? payload.jti : undefined,
    runId,
    scopeType,
    workspaceId: stringClaim(payload, 'workspace_id'),
    sessionId: stringClaim(payload, 'session_id'),
    allowedProviders: stringArrayClaim(permissionObject.allowed_providers, 'allowed_providers'),
    allowedTools: stringArrayClaim(permissionObject.allowed_tools, 'allowed_tools'),
    allowedToolOperations: toolOperationMapClaim(permissionObject.allowed_tool_operations),
    allowedModels: stringArrayClaim(permissionObject.allowed_models, 'allowed_models'),
    maxOutputTokens: typeof maxOutputTokens === 'number' ? maxOutputTokens : undefined,
    contextGrants: permissionObject.context_grants === undefined
      ? []
      : stringArrayClaim(permissionObject.context_grants, 'context_grants')
  };

  if (scopeType === 'workspace') {
    const targetType = optionalStringClaim(payload, 'target_type');
    if (targetType !== undefined && !isTargetType(targetType)) {
      throw new Error('Gateway token claim target_type is unsupported');
    }
    return {
      ...baseClaims,
      workflowId: stringClaim(payload, 'workflow_id'),
      workflowRunId: stringClaim(payload, 'workflow_run_id'),
      workflowSessionId: stringClaim(payload, 'workflow_session_id'),
      workflowStepId: optionalStringClaim(payload, 'workflow_step_id'),
      targetId: optionalStringClaim(payload, 'target_id'),
      targetType
    };
  }

  const targetType = stringClaim(payload, 'target_type');
  if (!isTargetType(targetType)) {
    throw new Error('Gateway token claim target_type is unsupported');
  }
  return {
    ...baseClaims,
    targetId: stringClaim(payload, 'target_id'),
    targetType
  };
}

export class GatewayTokenService {
  private readonly keys: KeyMaterial;
  private readonly verificationKeys: GatewayVerificationKey[];
  private readonly appConfig: AppConfig;

  constructor(appConfig: AppConfig = config) {
    this.appConfig = appConfig;
    this.keys = createKeys(appConfig);
    this.verificationKeys = parseVerificationKeys(appConfig);
  }

  async signRunScopeToken(input: RunScopeClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.appConfig.GATEWAY_TOKEN_TTL_SECONDS;

    const permissionPayload: Record<string, unknown> = {
      allowed_providers: input.allowedProviders,
      allowed_tools: input.allowedTools,
      allowed_tool_operations: input.allowedToolOperations || {},
      max_output_tokens: input.maxOutputTokens ?? null,
      allowed_models: input.allowedModels || []
    };
    if (input.scopeType === 'workspace') {
      permissionPayload.context_grants = input.contextGrants || [];
    }

    const payload: JWTPayload = {
      iss: this.appConfig.GATEWAY_TOKEN_ISSUER,
      aud: this.appConfig.GATEWAY_TOKEN_AUDIENCE,
      sub: `run:${input.runId}`,
      iat: now,
      exp,
      jti: randomUUID(),
      run_id: input.runId,
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      permissions: permissionPayload
    };

    if (input.scopeType === 'workspace') {
      payload.scope = { type: 'workspace' };
      payload.workflow_id = input.workflowId;
      payload.workflow_run_id = input.workflowRunId;
      payload.workflow_session_id = input.workflowSessionId;
      if (input.workflowStepId) {
        payload.workflow_step_id = input.workflowStepId;
      }
      if (input.targetId) {
        payload.target_id = input.targetId;
      }
      if (input.targetType) {
        payload.target_type = input.targetType;
      }
    } else {
      payload.target_id = input.targetId;
      payload.target_type = input.targetType;
    }

    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: this.appConfig.GATEWAY_SIGNING_KID })
      .sign(this.keys.privateKey);
  }

  async verifyRunScopeToken(token: string): Promise<VerifiedRunScopeClaims> {
    const jwks = await this.getJwks();
    const verification = await jwtVerify(
      token,
      createLocalJWKSet(jwks),
      {
        issuer: this.appConfig.GATEWAY_TOKEN_ISSUER,
        audience: this.appConfig.GATEWAY_TOKEN_AUDIENCE
      }
    );
    return parseRunScopeClaims(verification.payload);
  }

  async getJwks(): Promise<JSONWebKeySet> {
    const jwk = await exportJWK(this.keys.publicKey);
    return {
      keys: [
        {
          ...jwk,
          kid: this.appConfig.GATEWAY_SIGNING_KID,
          alg: 'RS256',
          use: 'sig'
        },
        ...this.verificationKeys
      ]
    };
  }
}

export const gatewayTokenService = new GatewayTokenService();
