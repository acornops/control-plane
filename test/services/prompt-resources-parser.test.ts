import assert from 'node:assert/strict';
import test from 'node:test';
import contractJson from '../../../contracts/prompt-reference-conformance.json' with { type: 'json' };
import { parsePromptReferences } from '../../src/services/prompt-resources/parser.js';

type TokenVector = { type: string; label: string; state: 'placeholder' | 'concrete' };
type Contract = {
  valid: Array<{ name: string; prompt: string; normalizedPrompt?: string; tokens: TokenVector[] }>;
  invalid: Array<{ name: string; prompt?: string; repeat?: { token: string; count: number }; errorCode: string }>;
};

const contract = contractJson as Contract;

for (const vector of contract.valid) {
  test(`prompt parser: ${vector.name}`, () => {
    const result = parsePromptReferences(vector.prompt);
    assert.equal(result.prompt, vector.normalizedPrompt || vector.prompt);
    assert.deepEqual(result.tokens.map(({ type, label, state }) => ({ type, label, state })), vector.tokens);
    assert.deepEqual(result.errors, []);
  });
}

for (const vector of contract.invalid) {
  test(`prompt parser rejects: ${vector.name}`, () => {
    const prompt = vector.prompt ?? vector.repeat!.token.repeat(vector.repeat!.count);
    assert.ok(parsePromptReferences(prompt).errors.some((error) => error.code === vector.errorCode));
  });
}
