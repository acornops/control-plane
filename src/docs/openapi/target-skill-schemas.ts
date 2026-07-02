import { TARGET_TYPES } from '../../types/domain.js';

interface TargetSkillOpenApiSchemas {
  targetSkillCatalogSchema: Record<string, unknown>;
  targetSkillDetailSchema: Record<string, unknown>;
  targetSkillFileRequestSchema: Record<string, unknown>;
  targetSkillGitImportSourceRequestSchema: Record<string, unknown>;
}

export function buildTargetSkillSchemas(): TargetSkillOpenApiSchemas {
  const targetSkillSourceSchema = {
    type: 'object',
    required: ['type', 'syncStatus'],
    properties: {
      type: { type: 'string', enum: ['manual', 'git_import'] },
      provider: { type: 'string', enum: ['github', 'gitlab'] },
      repoUrl: { type: 'string', format: 'uri' },
      apiBaseUrl: { type: 'string', format: 'uri' },
      ref: { type: 'string' },
      subpath: { type: 'string' },
      commitSha: { type: 'string' },
      syncStatus: { type: 'string', enum: ['not_applicable', 'current', 'modified'] }
    }
  };
  const targetSkillSummarySchema = {
    type: 'object',
    required: [
      'id',
      'workspaceId',
      'targetId',
      'targetType',
      'name',
      'description',
      'enabled',
      'validationStatus',
      'validationErrors',
      'bundleStats',
      'source',
      'createdAt',
      'updatedAt'
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      workspaceId: { type: 'string', format: 'uuid' },
      targetId: { type: 'string', format: 'uuid' },
      targetType: { type: 'string', enum: [...TARGET_TYPES] },
      clusterId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: 'string' },
      enabled: { type: 'boolean' },
      validationStatus: { type: 'string', enum: ['valid', 'invalid'] },
      validationErrors: { type: 'array', items: { type: 'string' } },
      bundleStats: {
        type: 'object',
        required: ['fileCount', 'totalBytes'],
        properties: {
          fileCount: { type: 'integer', minimum: 1, maximum: 16 },
          totalBytes: { type: 'integer', minimum: 0, maximum: 131072 }
        }
      },
      source: targetSkillSourceSchema,
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  };
  const targetSkillFileSchema = {
    type: 'object',
    required: ['path', 'content', 'sizeBytes'],
    properties: {
      path: { type: 'string', example: 'SKILL.md' },
      content: { type: 'string' },
      sizeBytes: { type: 'integer', minimum: 0, maximum: 32768 }
    }
  };
  return {
    targetSkillFileRequestSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', example: 'SKILL.md' },
        content: { type: 'string' }
      }
    },
    targetSkillGitImportSourceRequestSchema: {
      type: 'object',
      required: ['provider', 'repoUrl', 'ref'],
      properties: {
        provider: { type: 'string', enum: ['github', 'gitlab'], example: 'github' },
        repoUrl: { type: 'string', format: 'uri', example: 'https://github.com/openai/skills' },
        apiBaseUrl: { type: 'string', format: 'uri', example: 'https://github.internal/api/v3' },
        ref: { type: 'string', example: 'main' },
        subpath: { type: 'string', example: 'skills/.curated/cli-creator' },
        commitSha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$', example: '0123456789abcdef0123456789abcdef01234567' }
      }
    },
    targetSkillDetailSchema: {
      allOf: [
        targetSkillSummarySchema,
        {
          type: 'object',
          required: ['files'],
          properties: {
            files: { type: 'array', items: targetSkillFileSchema }
          }
        }
      ]
    },
    targetSkillCatalogSchema: {
      type: 'object',
      required: ['workspaceId', 'targetId', 'targetType', 'permissions', 'items'],
      properties: {
        workspaceId: { type: 'string', format: 'uuid' },
        targetId: { type: 'string', format: 'uuid' },
        targetType: { type: 'string', enum: [...TARGET_TYPES] },
        clusterId: { type: 'string', format: 'uuid' },
        permissions: {
          type: 'object',
          required: ['canEdit', 'editableRoles'],
          properties: {
            canEdit: { type: 'boolean' },
            editableRoles: { type: 'array', items: { type: 'string' } }
          }
        },
        items: { type: 'array', items: targetSkillSummarySchema },
        nextCursor: { type: 'string' }
      }
    }
  };
}
