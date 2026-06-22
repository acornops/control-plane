import assert from 'node:assert/strict';
import test from 'node:test';

import { runCommitSchema } from '../src/types/contracts.js';

test('run commit validation accepts Python UTC offset datetimes', () => {
  const parsed = runCommitSchema.safeParse({
    status: 'completed',
    assistant_message: {
      content: 'Done.',
      format: 'markdown'
    },
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      tool_calls: 1
    },
    timing: {
      started_at: '2026-06-22T14:45:00.000000+00:00',
      ended_at: '2026-06-22T14:45:15.000000+00:00'
    }
  });

  assert.equal(parsed.success, true);
});

test('run commit validation normalizes null reasoning token usage from Python clients', () => {
  const parsed = runCommitSchema.safeParse({
    status: 'completed',
    assistant_message: {
      content: 'Done.',
      format: 'markdown'
    },
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      tool_calls: 1,
      reasoning_tokens: null
    },
    timing: {
      started_at: '2026-06-22T17:03:29.877002Z',
      ended_at: '2026-06-22T17:03:44.686746Z'
    }
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) {
    return;
  }
  assert.equal(parsed.data.usage.reasoning_tokens, undefined);
});
