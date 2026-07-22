import { JsonSchema } from './schema-types.js';
import { buildAgentSchemas } from './schema-components-agents.js';
import { buildAdminSchemas } from './schema-components-admin.js';
import { buildCommonSchemas } from './schema-components-common.js';
import { buildTargetRuntimeSchemas } from './schema-components-targets.js';
import { buildAuthWorkspaceSchemas } from './schema-components-workspace.js';
import { buildWorkflowSchemas } from './schema-components-workflows.js';
import { buildCatalogSchemas } from './schema-components-catalog.js';

export function buildSharedOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    ...buildCommonSchemas(),
    ...buildAgentSchemas(),
    ...buildAuthWorkspaceSchemas(),
    ...buildWorkflowSchemas(),
    ...buildCatalogSchemas(),
    ...buildTargetRuntimeSchemas(),
    ...buildAdminSchemas()
  };
}
