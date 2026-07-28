export const AUTO_TRIAGE_INSTRUCTIONS_MAX_CHARACTERS = 4_000;

export function normalizeAutoTriageInstructions(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

export function autoTriageInstructionsFitLimit(value: string): boolean {
  return [...normalizeAutoTriageInstructions(value)].length
    <= AUTO_TRIAGE_INSTRUCTIONS_MAX_CHARACTERS;
}
