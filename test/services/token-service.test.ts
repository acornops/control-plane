import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { createLocalJWKSet, decodeProtectedHeader, exportJWK, jwtVerify, SignJWT, type JSONWebKeySet } from 'jose';
import { type AppConfig, config } from '../../src/config.js';
import { GatewayTokenService, gatewayTokenService } from '../../src/services/token-service.js';

describe('gateway token service', () => {
  it('signs run-scope tokens with the configured issuer, audience, and permissions', async () => {
    const token = await gatewayTokenService.signRunScopeToken({
      runId: 'run-1',
      workspaceId: 'ws-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      sessionId: 'session-1',
      allowedProviders: ['anthropic', 'gemini'],
      allowedTools: ['get_resource', 'get_resource_logs'],
      allowedToolOperations: {
        get_resource: 'read',
        get_resource_logs: 'read'
      },
      maxOutputTokens: 2048,
      allowedModels: ['gemini-2.0-flash']
    });
    const jwks = await gatewayTokenService.getJwks();
    const verification = await jwtVerify(
      token,
      createLocalJWKSet(jwks as JSONWebKeySet),
      {
        issuer: config.GATEWAY_TOKEN_ISSUER,
        audience: config.GATEWAY_TOKEN_AUDIENCE
      }
    );

    assert.equal(decodeProtectedHeader(token).alg, 'RS256');
    assert.equal(decodeProtectedHeader(token).kid, config.GATEWAY_SIGNING_KID);
    assert.equal(verification.payload.sub, 'run:run-1');
    assert.equal(verification.payload.run_id, 'run-1');
    assert.equal(verification.payload.workspace_id, 'ws-1');
    assert.equal(verification.payload.target_id, 'cluster-1');
    assert.equal(verification.payload.target_type, 'kubernetes');
    assert.equal(verification.payload.session_id, 'session-1');
    assert.deepEqual(verification.payload.permissions, {
      allowed_providers: ['anthropic', 'gemini'],
      allowed_tools: ['get_resource', 'get_resource_logs'],
      allowed_tool_operations: {
        get_resource: 'read',
        get_resource_logs: 'read'
      },
      max_output_tokens: 2048,
      allowed_models: ['gemini-2.0-flash']
    });
    assert.equal(typeof verification.payload.jti, 'string');
  });

  it('verifies run-scope tokens into canonical internal claims', async () => {
    const token = await gatewayTokenService.signRunScopeToken({
      runId: 'run-verify',
      workspaceId: 'ws-verify',
      targetId: 'cluster-verify',
      targetType: 'kubernetes',
      sessionId: 'session-verify',
      allowedProviders: ['openai'],
      allowedTools: ['get_pods'],
      allowedToolOperations: { get_pods: 'read' },
      maxOutputTokens: 1024,
      allowedModels: ['gpt-4.1-mini']
    });

    const claims = await gatewayTokenService.verifyRunScopeToken(token);

    assert.equal(claims.subject, 'run:run-verify');
    assert.equal(typeof claims.tokenId, 'string');
    assert.equal(claims.runId, 'run-verify');
    assert.equal(claims.workspaceId, 'ws-verify');
    assert.equal(claims.targetId, 'cluster-verify');
    assert.equal(claims.targetType, 'kubernetes');
    assert.equal(claims.sessionId, 'session-verify');
    assert.deepEqual(claims.allowedProviders, ['openai']);
    assert.deepEqual(claims.allowedTools, ['get_pods']);
    assert.deepEqual(claims.allowedToolOperations, { get_pods: 'read' });
    assert.equal(claims.maxOutputTokens, 1024);
    assert.deepEqual(claims.allowedModels, ['gpt-4.1-mini']);
  });

  it('rejects tokens whose subject does not match the run id claim', async () => {
    const active = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
    const activePrivatePem = active.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const serviceConfig: AppConfig = {
      ...config,
      GATEWAY_SIGNING_KID: 'subject-match-kid',
      GATEWAY_SIGNING_PRIVATE_KEY_PEM: activePrivatePem,
      GATEWAY_SIGNING_PRIVATE_KEY_PEM_B64: undefined
    };
    const service = new GatewayTokenService(serviceConfig);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: serviceConfig.GATEWAY_TOKEN_ISSUER,
      aud: serviceConfig.GATEWAY_TOKEN_AUDIENCE,
      sub: 'run:other-run',
      iat: now,
      exp: now + 300,
      run_id: 'run-1',
      workspace_id: 'ws-1',
      target_id: 'cluster-1',
      target_type: 'kubernetes',
      session_id: 'session-1',
      permissions: {
        allowed_providers: ['openai'],
        allowed_tools: ['get_pods'],
        allowed_tool_operations: {
          get_pods: 'read',
          restart_workload: 'mutate'
        },
        allowed_models: [],
        max_output_tokens: null
      }
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: serviceConfig.GATEWAY_SIGNING_KID })
      .sign(active.privateKey);

    await assert.rejects(() => service.verifyRunScopeToken(token), /subject must match run_id/);
  });

  it('publishes a usable JWKS and defaults optional permission claims', async () => {
    const jwks = await gatewayTokenService.getJwks();
    const [publicKey] = jwks.keys;

    assert.equal(jwks.keys.length, 1);
    assert.equal(publicKey?.kid, config.GATEWAY_SIGNING_KID);
    assert.equal(publicKey?.alg, 'RS256');
    assert.equal(publicKey?.use, 'sig');
    assert.equal(publicKey?.kty, 'RSA');

    const token = await gatewayTokenService.signRunScopeToken({
      runId: 'run-2',
      workspaceId: 'ws-2',
      targetId: 'cluster-2',
      targetType: 'kubernetes',
      sessionId: 'session-2',
      allowedProviders: ['openai'],
      allowedTools: ['list_resources']
    });
    const verification = await jwtVerify(
      token,
      createLocalJWKSet(jwks as JSONWebKeySet),
      {
        issuer: config.GATEWAY_TOKEN_ISSUER,
        audience: config.GATEWAY_TOKEN_AUDIENCE
      }
    );

    assert.deepEqual(verification.payload.permissions, {
      allowed_providers: ['openai'],
      allowed_tools: ['list_resources'],
      allowed_tool_operations: {},
      max_output_tokens: null,
      allowed_models: []
    });
  });

  it('uses configured shared key material across service instances and publishes verification-only keys', async () => {
    const active = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
    const retired = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
    const activePrivatePem = active.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const retiredJwk = await exportJWK(retired.publicKey);
    const serviceConfig: AppConfig = {
      ...config,
      GATEWAY_SIGNING_KID: 'stable-kid',
      GATEWAY_SIGNING_PRIVATE_KEY_PEM: undefined,
      GATEWAY_SIGNING_PRIVATE_KEY_PEM_B64: Buffer.from(activePrivatePem).toString('base64'),
      GATEWAY_VERIFICATION_JWKS_JSON: JSON.stringify({
        keys: [{ ...retiredJwk, kid: 'retired-kid', alg: 'RS256', use: 'sig' }]
      })
    };
    const podA = new GatewayTokenService(serviceConfig);
    const podB = new GatewayTokenService(serviceConfig);

    const token = await podA.signRunScopeToken({
      runId: 'run-shared-key',
      workspaceId: 'ws-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      sessionId: 'session-1',
      allowedProviders: ['gemini'],
      allowedTools: ['get_resource']
    });
    const jwks = await podB.getJwks();

    assert.equal(decodeProtectedHeader(token).kid, 'stable-kid');
    assert.deepEqual(jwks.keys.map((key) => key.kid), ['stable-kid', 'retired-kid']);
    await jwtVerify(token, createLocalJWKSet(jwks as JSONWebKeySet), {
      issuer: serviceConfig.GATEWAY_TOKEN_ISSUER,
      audience: serviceConfig.GATEWAY_TOKEN_AUDIENCE
    });
  });

  it('drops malformed tool-operation metadata during token verification', async () => {
    const active = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
    const activePrivatePem = active.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const serviceConfig: AppConfig = {
      ...config,
      GATEWAY_SIGNING_KID: 'tool-operation-kid',
      GATEWAY_SIGNING_PRIVATE_KEY_PEM: activePrivatePem,
      GATEWAY_SIGNING_PRIVATE_KEY_PEM_B64: undefined
    };
    const service = new GatewayTokenService(serviceConfig);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: serviceConfig.GATEWAY_TOKEN_ISSUER,
      aud: serviceConfig.GATEWAY_TOKEN_AUDIENCE,
      sub: 'run:run-ops',
      iat: now,
      exp: now + 300,
      run_id: 'run-ops',
      workspace_id: 'ws-1',
      target_id: 'cluster-1',
      target_type: 'kubernetes',
      session_id: 'session-1',
      permissions: {
        allowed_providers: ['openai'],
        allowed_tools: ['get_pods', 'restart_workload'],
        allowed_tool_operations: {
          get_pods: 'read',
          restart_workload: 'mutate'
        },
        allowed_models: [],
        max_output_tokens: null
      }
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: serviceConfig.GATEWAY_SIGNING_KID })
      .sign(active.privateKey);

    const claims = await service.verifyRunScopeToken(token);

    assert.deepEqual(claims.allowedToolOperations, { get_pods: 'read' });
  });
});
