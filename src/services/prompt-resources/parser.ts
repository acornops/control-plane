import type {
  PromptReferenceParseError,
  PromptReferenceParseResult,
  PromptReferenceToken
} from '../../types/prompt-resources.js';

export const MAX_PROMPT_LENGTH = 32_768;
export const MAX_PROMPT_REFERENCES = 64;
const TYPE_START = /[a-z]/;
const TYPE_CONTINUE = /[a-z0-9_-]/;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;

function malformed(start: number, end: number, message: string): PromptReferenceParseError {
  return { code: 'PROMPT_REFERENCE_MALFORMED', message, start, end };
}

export function escapePromptReferenceLabel(label: string): string {
  return label.normalize('NFC').replaceAll('\\', '\\\\').replaceAll(']', '\\]');
}

export function formatPromptReference(type: string, label = ''): string {
  return `@${type}[${escapePromptReferenceLabel(label)}]`;
}

export function parsePromptReferences(rawPrompt: string): PromptReferenceParseResult {
  const prompt = rawPrompt.normalize('NFC');
  const tokens: PromptReferenceToken[] = [];
  const errors: PromptReferenceParseError[] = [];
  if (prompt.length > MAX_PROMPT_LENGTH) {
    errors.push({
      code: 'PROMPT_TOO_LONG',
      message: `Prompt exceeds the ${MAX_PROMPT_LENGTH} character limit.`
    });
    return { prompt, tokens, errors };
  }

  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== '@') continue;
    const start = index;
    let cursor = index + 1;
    if (!TYPE_START.test(prompt[cursor] || '')) continue;
    cursor += 1;
    while (cursor < prompt.length && TYPE_CONTINUE.test(prompt[cursor])) cursor += 1;
    const type = prompt.slice(index + 1, cursor);
    if (type.length > 64) {
      errors.push(malformed(start, cursor, 'Prompt reference type exceeds 64 characters.'));
      index = cursor - 1;
      continue;
    }
    if (prompt[cursor] !== '[') continue;
    cursor += 1;
    let label = '';
    let closed = false;
    while (cursor < prompt.length) {
      const character = prompt[cursor];
      if (character === ']') {
        cursor += 1;
        closed = true;
        break;
      }
      if (character === '\\') {
        const escaped = prompt[cursor + 1];
        if (escaped !== '\\' && escaped !== ']') {
          errors.push(malformed(start, Math.min(prompt.length, cursor + 2), 'Only \\\\ and \\] escapes are valid in prompt references.'));
          cursor += escaped === undefined ? 1 : 2;
          continue;
        }
        label += escaped;
        cursor += 2;
        continue;
      }
      if (CONTROL_CHARACTER.test(character)) {
        errors.push(malformed(start, cursor + 1, 'Prompt reference labels cannot contain control characters.'));
      }
      label += character;
      cursor += 1;
    }
    if (!closed) {
      errors.push(malformed(start, prompt.length, 'Prompt reference is missing a closing bracket.'));
      break;
    }
    const normalizedLabel = label.normalize('NFC').trim();
    if (!normalizedLabel) {
      errors.push(malformed(start, cursor, 'Prompt references must select a concrete resource. Use {{type:key}} for runtime input.'));
      index = cursor - 1;
      continue;
    }
    tokens.push({
      type,
      label: normalizedLabel,
      start,
      end: cursor
    });
    index = cursor - 1;
  }

  if (tokens.length > MAX_PROMPT_REFERENCES) {
    errors.push({
      code: 'PROMPT_REFERENCE_LIMIT_EXCEEDED',
      message: `Prompt contains more than ${MAX_PROMPT_REFERENCES} resource references.`
    });
  }
  return { prompt, tokens: tokens.slice(0, MAX_PROMPT_REFERENCES), errors };
}
