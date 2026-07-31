import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  requestedAutoTriageToolMode,
  resolveAutoTriageEffectiveBehavior,
  resolveAutoTriageReadiness
} from '../src/services/auto-triage-policy.js';
import { updateTargetAutoTriageSchema } from '../src/types/contracts.js';
import {
  issueMeetsAutoTriageThreshold,
  issueMatchesAutoTriageScope
} from '../src/utils/auto-triage-eligibility.js';

function resolution(input: {
  targetSupportsWrite: boolean;
  confirmationRequiredForWrite: boolean;
  writeAllowed: number;
}) {
  return {
    targetSupportsWrite: input.targetSupportsWrite,
    confirmationRequiredForWrite: input.confirmationRequiredForWrite,
    summary: {
      totalAllowed: input.writeAllowed + 1,
      functionAllowed: input.writeAllowed + 1,
      nativeAllowed: 0,
      readAllowed: 1,
      writeAllowed: input.writeAllowed,
      configuredWrite: input.writeAllowed,
      excludedWrite: 0
    }
  };
}

describe('target auto-triage policy', () => {
  it('keeps the API instruction limit aligned with the public 4,000-character contract', () => {
    const request = {
      expectedRevision: 0,
      enabled: true,
      minimumSeverity: 'warning',
      writeMode: 'read_only'
    };
    assert.equal(updateTargetAutoTriageSchema.safeParse({
      ...request,
      additionalInstructions: 'a'.repeat(4000)
    }).success, true);
    assert.equal(updateTargetAutoTriageSchema.safeParse({
      ...request,
      additionalInstructions: 'a'.repeat(4001)
    }).success, false);
    assert.equal(updateTargetAutoTriageSchema.safeParse({
      ...request,
      additionalInstructions: '🛠️'.repeat(2000)
    }).success, true);
    assert.equal(updateTargetAutoTriageSchema.safeParse({
      ...request,
      additionalInstructions: `${'a'.repeat(4000)}   \r\n`
    }).success, true);
  });

  it('normalizes and bounds Kubernetes namespace settings at the API boundary', () => {
    const request = {
      expectedRevision: 0,
      enabled: true,
      minimumSeverity: 'warning',
      writeMode: 'read_only',
      additionalInstructions: ''
    };
    const parsed = updateTargetAutoTriageSchema.parse({
      ...request,
      namespaceInclude: [' payments '],
      namespaceExclude: ['sandbox'],
      includeClusterScopedIssues: false
    });
    assert.deepEqual(parsed.namespaceInclude, ['payments']);
    assert.equal(updateTargetAutoTriageSchema.safeParse({
      ...request,
      namespaceInclude: ['Production']
    }).success, false);
    assert.equal(updateTargetAutoTriageSchema.safeParse({
      ...request,
      namespaceInclude: ['payments', 'payments']
    }).success, false);
    assert.equal(updateTargetAutoTriageSchema.safeParse({
      ...request,
      namespaceInclude: Array.from({ length: 101 }, (_, index) => `team-${index}`)
    }).success, false);
  });

  it('defaults every mode except diagnose-only to the target write-capable resolver', () => {
    assert.equal(requestedAutoTriageToolMode('read_only'), 'read_only');
    assert.equal(requestedAutoTriageToolMode('follow_target'), 'read_write');
    assert.equal(requestedAutoTriageToolMode('approval_required'), 'read_write');
    assert.equal(requestedAutoTriageToolMode('full_write'), 'read_write');
  });

  it('keeps diagnose-only read-only even when the target can write', () => {
    assert.deepEqual(
      resolveAutoTriageEffectiveBehavior('read_only', resolution({
        targetSupportsWrite: true,
        confirmationRequiredForWrite: false,
        writeAllowed: 1
      })),
      {
        requestedWriteMode: 'read_only',
        effectiveToolMode: 'read_only',
        confirmationRequiredForWrite: false,
        targetCeilingApplied: false,
        targetSupportsWrite: true,
        summary: 'read_only'
      }
    );
  });

  it('forces approval for ask-before-changes even when the target permits automatic writes', () => {
    const behavior = resolveAutoTriageEffectiveBehavior('approval_required', resolution({
      targetSupportsWrite: true,
      confirmationRequiredForWrite: false,
      writeAllowed: 1
    }));
    assert.equal(behavior.effectiveToolMode, 'read_write');
    assert.equal(behavior.confirmationRequiredForWrite, true);
    assert.equal(behavior.summary, 'approval_required');
  });

  it('reduces a full-write request when the target requires confirmation', () => {
    const behavior = resolveAutoTriageEffectiveBehavior('full_write', resolution({
      targetSupportsWrite: true,
      confirmationRequiredForWrite: true,
      writeAllowed: 1
    }));
    assert.equal(behavior.confirmationRequiredForWrite, true);
    assert.equal(behavior.targetCeilingApplied, true);
    assert.equal(behavior.summary, 'reduced_to_approval');
  });

  it('allows automatic writes only when the target permits them', () => {
    const behavior = resolveAutoTriageEffectiveBehavior('full_write', resolution({
      targetSupportsWrite: true,
      confirmationRequiredForWrite: false,
      writeAllowed: 1
    }));
    assert.equal(behavior.effectiveToolMode, 'read_write');
    assert.equal(behavior.confirmationRequiredForWrite, false);
    assert.equal(behavior.summary, 'automatic_write');
  });

  it('cannot enable writes on a read-only agent', () => {
    const behavior = resolveAutoTriageEffectiveBehavior('follow_target', resolution({
      targetSupportsWrite: false,
      confirmationRequiredForWrite: true,
      writeAllowed: 0
    }));
    assert.equal(behavior.effectiveToolMode, 'read_only');
    assert.equal(behavior.targetCeilingApplied, true);
    assert.equal(behavior.summary, 'agent_read_only');
  });

  it('uses inclusive severity thresholds', () => {
    assert.equal(issueMeetsAutoTriageThreshold('critical', 'critical'), true);
    assert.equal(issueMeetsAutoTriageThreshold('warning', 'critical'), false);
    assert.equal(issueMeetsAutoTriageThreshold('critical', 'warning'), true);
    assert.equal(issueMeetsAutoTriageThreshold('warning', 'warning'), true);
    assert.equal(issueMeetsAutoTriageThreshold('info', 'warning'), false);
    assert.equal(issueMeetsAutoTriageThreshold('info', 'info'), true);
  });

  it('limits Kubernetes eligibility to included namespaces while exclusions win', () => {
    const settings = {
      namespaceInclude: ['payments', 'production'],
      namespaceExclude: ['production'],
      includeClusterScopedIssues: false
    };
    assert.equal(issueMatchesAutoTriageScope({
      targetType: 'kubernetes',
      scopeKind: 'Namespace',
      scopeName: 'payments'
    }, settings), true);
    assert.equal(issueMatchesAutoTriageScope({
      targetType: 'kubernetes',
      scopeKind: 'Namespace',
      scopeName: 'production'
    }, settings), false);
    assert.equal(issueMatchesAutoTriageScope({
      targetType: 'kubernetes',
      scopeKind: undefined,
      scopeName: undefined
    }, settings), false);
    assert.equal(issueMatchesAutoTriageScope({
      targetType: 'kubernetes',
      scopeKind: 'Cluster',
      scopeName: undefined
    }, {
      ...settings,
      includeClusterScopedIssues: true
    }), true);
    assert.equal(issueMatchesAutoTriageScope({
      targetType: 'kubernetes',
      scopeKind: 'Namespace',
      scopeName: '   '
    }, settings), false);
  });

  it('does not apply Kubernetes namespace eligibility to virtual machines', () => {
    assert.equal(issueMatchesAutoTriageScope({
      targetType: 'virtual_machine',
      scopeKind: undefined,
      scopeName: undefined
    }, {
      namespaceInclude: ['payments'],
      namespaceExclude: [],
      includeClusterScopedIssues: false
    }), true);
  });

  it('blocks before chat creation when configured MCP tools cannot bootstrap', () => {
    assert.deepEqual(resolveAutoTriageReadiness({
      credentialConfigured: true,
      diagnosticToolCount: 2,
      targetStatus: 'online',
      hasBlockingMcpReadiness: true,
      unavailableOptionalMcpToolCount: 0
    }), {
      status: 'needs_setup',
      reasons: ['mcp_tools_need_setup'],
      unavailableOptionalMcpToolCount: 0
    });
  });
});
