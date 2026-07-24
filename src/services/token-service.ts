import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { createLocalJWKSet, exportJWK, jwtVerify, SignJWT, type JSONWebKeySet, type JWK, type JWTPayload } from 'jose';
import { type AppConfig, config } from '../config.js';
import { isTargetType, type TargetType, type WorkspaceAuditOperation } from '../types/domain.js';
import type { PromptResourceBinding } from '../types/prompt-resources.js';
import { createResourceBindingClaims, readResourceBindingClaims } from './token-resource-bindings.js';

export type RunScopeType = 'target' | 'workspace';

export interface NativeToolPermission {
  id: string;
  config: Record<string, unknown>;
}

export interface McpToolRef {
  serverId: string;
  toolName: string;
}

export interface ApprovalReceiptClaims {
  approvalId: string;
  runId: string;
  workspaceId: string;
  toolCallId: string;
  toolAlias: string;
  serverId: string;
  serverToolName: string;
  argumentsDigest: string;
}

export interface RunPrincipalRef {
  type: 'user' | 'service_identity';
  id: string;
}

export type RunPermissionMode = 'read_only' | 'ask_before_changes' | 'auto_allowed_changes';

interface BaseRunScopeClaims {
  runId: string;
  workspaceId: string;
  sessionId: string;
  userId?: string;
  principal?: RunPrincipalRef;
  permissionMode?: RunPermissionMode;
  allowedProviders: string[];
  allowedTools: string[];
  allowedToolRefs?: McpToolRef[];
  allowedNativeTools?: NativeToolPermission[];
  allowedToolOperations?: Record<string, WorkspaceAuditOperation>;
  maxOutputTokens?: number;
  allowedModels?: string[];
  resourceBindings?: PromptResourceBinding[];
  bindingDigest?: string;
}

type VerifiedResourceBindingClaim = PromptResourceBinding;

export interface TargetRunScopeClaims extends BaseRunScopeClaims {
  scopeType?: 'target';
  targetId: string;
  targetType: TargetType;
  agentId?: string;
  agentVersion?: number;
}

export interface WorkflowRunScopeClaims extends BaseRunScopeClaims {
  scopeType: 'workspace';
  workflowId: string;
  executionId: string;
  workflowSessionId: string;
  executorRole: 'coordinator' | 'specialist';
  agentId?: string;
  agentVersion?: number;
  triggerId?: string;
  contextGrants?: string[];
  targetId?: string;
  targetType?: TargetType;
}

export type RunScopeClaims = TargetRunScopeClaims | WorkflowRunScopeClaims;

export interface VerifiedRunScopeClaims extends BaseRunScopeClaims {
  subject: string;
  tokenId?: string;
  scopeType: RunScopeType;
  allowedNativeTools: NativeToolPermission[];
  targetId?: string;
  targetType?: TargetType;
  workflowId?: string;
  executionId?: string;
  workflowSessionId?: string;
  executorRole?: 'coordinator' | 'specialist';
  agentId?: string;
  agentVersion?: number;
  triggerId?: string;
  contextGrants: string[];
  principal: RunPrincipalRef;
  permissionMode: RunPermissionMode;
  resourceBindings: VerifiedResourceBindingClaim[];
  bindingDigest?: string;
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

function optionalNumberClaim(payload: JWTPayload, key: string): number | undefined {
  const value = payload[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Gateway token claim ${key} must be a finite number when present`);
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

function nativeToolPermissionsClaim(value: unknown): NativeToolPermission[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('Gateway token permission allowed_native_tools must be an array');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Gateway token permission allowed_native_tools entries must be objects');
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.trim().length === 0) {
      throw new Error('Gateway token permission allowed_native_tools entries require id');
    }
    if (item.config !== undefined && (!item.config || typeof item.config !== 'object' || Array.isArray(item.config))) {
      throw new Error('Gateway token permission allowed_native_tools config must be an object');
    }
    return {
      id: item.id,
      config: (item.config as Record<string, unknown> | undefined) || {}
    };
  });
}

function mcpToolRefsClaim(value: unknown): McpToolRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('Gateway token permission allowed_tool_refs must be an array');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Gateway token permission allowed_tool_refs entries must be objects');
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.server_id !== 'string' || typeof item.tool_name !== 'string') {
      throw new Error('Gateway token MCP tool refs require server_id and tool_name');
    }
    return { serverId: item.server_id, toolName: item.tool_name };
  });
}

function principalClaim(value: unknown, userId?: string): RunPrincipalRef {
  if (value === undefined || value === null) {
    if (userId) return { type: 'user', id: userId };
    throw new Error('Gateway token run principal is required');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway token run principal must be an object');
  }
  const item = value as Record<string, unknown>;
  if ((item.type !== 'user' && item.type !== 'service_identity')
    || typeof item.id !== 'string' || !item.id.trim()) {
    throw new Error('Gateway token run principal is invalid');
  }
  if (userId && (item.type !== 'user' || item.id !== userId)) {
    throw new Error('Gateway token user_id and run principal must match');
  }
  return { type: item.type, id: item.id };
}

function permissionModeClaim(value: unknown): RunPermissionMode {
  if (value === undefined || value === null) return 'ask_before_changes';
  if (value !== 'read_only' && value !== 'ask_before_changes' && value !== 'auto_allowed_changes') {
    throw new Error('Gateway token permission_mode is invalid');
  }
  return value;
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

  const workspaceId = stringClaim(payload, 'workspace_id');
  const userId = optionalStringClaim(payload, 'user_id');
  const { resourceBindings, bindingDigest } = readResourceBindingClaims(permissionObject, workspaceId);
  const baseClaims = {
    subject,
    tokenId: typeof payload.jti === 'string' ? payload.jti : undefined,
    runId,
    scopeType,
    workspaceId,
    sessionId: stringClaim(payload, 'session_id'),
    userId,
    principal: principalClaim(payload.principal, userId),
    permissionMode: permissionModeClaim(payload.permission_mode),
    allowedProviders: stringArrayClaim(permissionObject.allowed_providers, 'allowed_providers'),
    allowedTools: stringArrayClaim(permissionObject.allowed_tools, 'allowed_tools'),
    allowedToolRefs: mcpToolRefsClaim(permissionObject.allowed_tool_refs),
    allowedNativeTools: nativeToolPermissionsClaim(permissionObject.allowed_native_tools),
    allowedToolOperations: toolOperationMapClaim(permissionObject.allowed_tool_operations),
    allowedModels: stringArrayClaim(permissionObject.allowed_models, 'allowed_models'),
    maxOutputTokens: typeof maxOutputTokens === 'number' ? maxOutputTokens : undefined,
    contextGrants: permissionObject.context_grants === undefined
      ? []
      : stringArrayClaim(permissionObject.context_grants, 'context_grants'),
    resourceBindings,
    bindingDigest
  };

  if (scopeType === 'workspace') {
    const targetType = optionalStringClaim(payload, 'target_type');
    if (targetType !== undefined && !isTargetType(targetType)) {
      throw new Error('Gateway token claim target_type is unsupported');
    }
    const executorRole = stringClaim(payload, 'executor_role');
    if (executorRole !== 'coordinator' && executorRole !== 'specialist') {
      throw new Error('Gateway token claim executor_role is unsupported');
    }
    const agentId = optionalStringClaim(payload, 'agent_id');
    const agentVersion = optionalNumberClaim(payload, 'agent_version');
    if (executorRole === 'coordinator' && (agentId || agentVersion !== undefined)) {
      throw new Error('Coordinator Workflow tokens must not contain Agent identity claims');
    }
    if (executorRole === 'specialist' && (!agentId || agentVersion === undefined)) {
      throw new Error('Specialist Workflow tokens require Agent identity claims');
    }
    return {
      ...baseClaims,
      workflowId: stringClaim(payload, 'workflow_id'),
      executionId: stringClaim(payload, 'execution_id'),
      workflowSessionId: stringClaim(payload, 'workflow_session_id'),
      executorRole,
      agentId,
      agentVersion,
      triggerId: optionalStringClaim(payload, 'trigger_id'),
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
    targetType,
    agentId: optionalStringClaim(payload, 'agent_id'),
    agentVersion: optionalNumberClaim(payload, 'agent_version')
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
      allowed_tool_refs: (input.allowedToolRefs || []).map((ref) => ({
        server_id: ref.serverId,
        tool_name: ref.toolName
      })),
      allowed_native_tools: input.allowedNativeTools || [],
      allowed_tool_operations: input.allowedToolOperations || {},
      max_output_tokens: input.maxOutputTokens ?? null,
      allowed_models: input.allowedModels || []
    };
    Object.assign(permissionPayload, createResourceBindingClaims(
      input.resourceBindings || [],
      input.bindingDigest,
      input.workspaceId
    ));
    if (input.scopeType === 'workspace') {
      permissionPayload.context_grants = input.contextGrants || [];
    }

    const principal = input.principal || (input.userId ? { type: 'user' as const, id: input.userId } : undefined);
    if (!principal) throw new Error('Run principal is required to sign a gateway token');
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
      user_id: input.userId,
      principal,
      permission_mode: input.permissionMode || 'ask_before_changes',
      permissions: permissionPayload
    };

    if (input.scopeType === 'workspace') {
      if (input.executorRole === 'coordinator' && (input.agentId || input.agentVersion !== undefined)) {
        throw new Error('Coordinator Workflow tokens must not contain Agent identity claims');
      }
      if (input.executorRole === 'specialist' && (!input.agentId || input.agentVersion === undefined)) {
        throw new Error('Specialist Workflow tokens require Agent identity claims');
      }
      payload.scope = { type: 'workspace' };
      payload.workflow_id = input.workflowId;
      payload.execution_id = input.executionId;
      payload.workflow_session_id = input.workflowSessionId;
      payload.executor_role = input.executorRole;
      if (input.agentId) {
        payload.agent_id = input.agentId;
      }
      if (typeof input.agentVersion === 'number') {
        payload.agent_version = input.agentVersion;
      }
      if (input.triggerId) {
        payload.trigger_id = input.triggerId;
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
      if (input.agentId) payload.agent_id = input.agentId;
      if (typeof input.agentVersion === 'number') payload.agent_version = input.agentVersion;
    }

    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: this.appConfig.GATEWAY_SIGNING_KID })
      .sign(this.keys.privateKey);
  }

  async signApprovalReceipt(input: ApprovalReceiptClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload: JWTPayload = {
      iss: this.appConfig.GATEWAY_TOKEN_ISSUER,
      aud: 'acornops-mcp-approval',
      sub: `approval:${input.approvalId}`,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
      approval_id: input.approvalId,
      run_id: input.runId,
      workspace_id: input.workspaceId,
      tool_call_id: input.toolCallId,
      tool_alias: input.toolAlias,
      server_id: input.serverId,
      server_tool_name: input.serverToolName,
      arguments_digest: input.argumentsDigest
    };
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', typ: 'acornops-approval+jwt', kid: this.appConfig.GATEWAY_SIGNING_KID })
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
