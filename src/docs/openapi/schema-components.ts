import { JsonSchema } from './schema-types.js';
import { buildAgentSchemas } from './schema-components-agents.js';
import { buildAdminSchemas } from './schema-components-admin.js';
import { buildCommonSchemas } from './schema-components-common.js';
import { buildTargetRuntimeSchemas } from './schema-components-targets.js';
import { buildAuthWorkspaceSchemas } from './schema-components-workspace.js';

export function buildSharedOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    ...buildCommonSchemas(),
    ...buildAgentSchemas(),
    ...buildAuthWorkspaceSchemas(),
    ...buildTargetRuntimeSchemas(),
    ...buildAdminSchemas()
  };
}
