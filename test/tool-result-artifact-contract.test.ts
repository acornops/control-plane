import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runEventSchema, toolResultArtifactCreateSchema } from '../src/types/contracts.js';

describe('tool result artifact request contract', () => {
  it('requires an explicit result while allowing JSON null', () => {
    assert.equal(toolResultArtifactCreateSchema.safeParse({
      callId: 'call-1', toolName: 'get_resource'
    }).success, false);
    assert.equal(toolResultArtifactCreateSchema.safeParse({
      callId: 'call-1', toolName: 'get_resource', result: null
    }).success, true);
  });

  it('requires string results for plain-text artifacts', () => {
    const parsed = toolResultArtifactCreateSchema.safeParse({
      callId: 'call-1', toolName: 'logs', result: {}, contentType: 'text/plain'
    });
    assert.equal(parsed.success, false);
  });

  it('rejects complete results from compact run events', () => {
    const event = {
      schema_version: 1,
      run_id: '123e4567-e89b-42d3-a456-426614174000',
      seq: 1,
      ts: '2026-07-13T00:00:00.000Z',
      type: 'tool_call_completed',
      payload: {
        call_id: 'call-1', tool: 'get_resource', result: { status: 'ok' }, is_error: false,
        context_meta: {
          schema_version: 'v1', strategy: 'producer_projection', original_bytes: 100,
          context_bytes: 15, truncated: false, omissions: []
        }
      }
    };
    assert.equal(runEventSchema.safeParse(event).success, true);
    for (const key of ['full_result', 'fullResult', 'structuredContent', 'complete_result']) {
      assert.equal(runEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, [key]: { secret: 'must-not-enter-sse' } }
      }).success, false);
    }
  });

  it('rejects oversized model context from compact run events', () => {
    const parsed = runEventSchema.safeParse({
      schema_version: 1,
      run_id: '123e4567-e89b-42d3-a456-426614174000',
      seq: 1,
      ts: '2026-07-13T00:00:00.000Z',
      type: 'tool_call_completed',
      payload: {
        call_id: 'call-1', tool: 'get_resource', result: { value: 'x'.repeat(13 * 1024) },
        context_meta: {
          schema_version: 'v1', strategy: 'producer_projection', original_bytes: 20_000,
          context_bytes: 12 * 1024, truncated: true, omissions: []
        },
        is_error: false
      }
    });
    assert.equal(parsed.success, false);
  });
});
