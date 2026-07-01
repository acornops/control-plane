import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractTargetInsightsQueryTerms } from '../src/store/repository-target-insights.js';

describe('Target Insights query term extraction', () => {
  it('keeps a single high-signal incident token from conversational Target Insights questions', () => {
    assert.deepEqual(
      extractTargetInsightsQueryTerms('Do we have target insights about crashloopbackoff?'),
      {
        terms: ['crashloopbackoff'],
        strongTerms: ['crashloopbackoff']
      }
    );
  });

  it('extracts general agent-memory terms without treating ordinary nouns as strong', () => {
    assert.deepEqual(
      extractTargetInsightsQueryTerms('Why did vendor approval get skipped?'),
      {
        terms: ['vendor', 'approval', 'skipped'],
        strongTerms: []
      }
    );
  });

  it('does not make broad product nouns strong enough for one-word text matches', () => {
    assert.deepEqual(
      extractTargetInsightsQueryTerms('Tell me about automation'),
      {
        terms: ['automation'],
        strongTerms: []
      }
    );
  });

  it('preserves structured identifiers and codes as strong terms', () => {
    assert.deepEqual(
      extractTargetInsightsQueryTerms('Why did vendor-id-123 receive HTTP 500?'),
      {
        terms: ['vendor-id-123', 'receive', 'http', '500'],
        strongTerms: ['vendor-id-123', 'http', '500']
      }
    );
  });
});
