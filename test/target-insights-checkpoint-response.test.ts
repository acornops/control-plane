import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTargetInsightsCheckpointResponse } from '../src/services/target-insights/checkpoint-response.js';

describe('Target Insights checkpoint response validation', () => {
  it('accepts an explicit no-op with a bounded reason code', () => {
    assert.deepEqual(
      parseTargetInsightsCheckpointResponse(
        '{"patches":[{"action":"noop","reasonCode":"insufficient_evidence"}]}',
        new Set()
      ),
      {
        ok: true,
        decision: { kind: 'noop', reasonCode: 'insufficient_evidence' },
        proposedPatchCount: 1
      }
    );
  });

  it('rejects malformed and incomplete output instead of treating it as a no-op', () => {
    assert.deepEqual(
      parseTargetInsightsCheckpointResponse('not json', new Set()),
      { ok: false, reasonCode: 'invalid_json', proposedPatchCount: 0 }
    );
    assert.deepEqual(
      parseTargetInsightsCheckpointResponse(
        '{"patches":[{"action":"create","title":"Missing the required body"}]}',
        new Set()
      ),
      { ok: false, reasonCode: 'invalid_schema', proposedPatchCount: 1 }
    );
  });

  it('enforces the existing entry limits and rejects unknown fields', () => {
    const overLimitTags = Array.from({ length: 33 }, (_, index) => `tag-${index}`);
    for (const patch of [
      { action: 'create', title: 'Too many tags', bodyMarkdown: 'Body', tags: overLimitTags },
      { action: 'create', title: 'Too many observations', bodyMarkdown: 'Body', observationCount: 100_001 },
      { action: 'noop', reasonCode: 'no_durable_learning', explanation: 'Free-form reasons are not audited.' }
    ]) {
      assert.deepEqual(
        parseTargetInsightsCheckpointResponse(JSON.stringify({ patches: [patch] }), new Set()),
        { ok: false, reasonCode: 'invalid_schema', proposedPatchCount: 1 }
      );
    }
  });

  it('rejects mixed no-op decisions and unknown entry references', () => {
    assert.deepEqual(
      parseTargetInsightsCheckpointResponse(JSON.stringify({
        patches: [
          { action: 'noop', reasonCode: 'already_captured' },
          { action: 'create', title: 'Registry failures', bodyMarkdown: 'Refresh the pull secret.' }
        ]
      }), new Set()),
      { ok: false, reasonCode: 'mixed_noop', proposedPatchCount: 2 }
    );
    assert.deepEqual(
      parseTargetInsightsCheckpointResponse(
        '{"patches":[{"action":"archive","entryId":"missing-entry"}]}',
        new Set(['entry-1'])
      ),
      { ok: false, reasonCode: 'unknown_entry', proposedPatchCount: 1 }
    );
  });

  it('accepts strict create, update, and archive mutations', () => {
    const result = parseTargetInsightsCheckpointResponse(JSON.stringify({
      patches: [
        {
          action: 'create',
          title: 'Registry authentication failures',
          bodyMarkdown: 'Refresh the image pull secret.',
          observationCount: 3,
          confidence: 0.9
        },
        {
          action: 'update',
          entryId: 'entry-1',
          evidenceSummary: 'Confirmed in another namespace.'
        },
        { action: 'archive', entryId: 'entry-2' }
      ]
    }), new Set(['entry-1', 'entry-2']));

    assert.equal(result.ok, true);
    assert.equal(result.proposedPatchCount, 3);
    if (result.ok) assert.equal(result.decision.kind, 'patches');
  });
});
