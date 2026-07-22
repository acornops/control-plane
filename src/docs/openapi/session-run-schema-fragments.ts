export { buildToolResultArtifactPaths } from './tool-result-artifact-paths.js';

export const assistantReferencesRequestProperty = {
  type: 'array',
  maxItems: 8,
  uniqueItems: true,
  description: 'Optional target-scoped tool and skill references selected with the chat slash picker. Tool IDs are runtime aliases; skill IDs are target skill IDs.',
  items: {
    type: 'object',
    required: ['kind', 'id'],
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['tool', 'skill'] },
      id: { type: 'string', minLength: 1, maxLength: 256 }
    }
  }
};
