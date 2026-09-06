import { config } from '../../config.js';
import type { TargetType } from '../../types/domain.js';
import type { InsightsExecution } from '../insights-capacity.js';
import { internalFetch } from '../internal-http-client.js';
import { gatewayTokenService } from '../token-service.js';
import { readGatewayTextStream } from './gateway-text-stream.js';

export async function streamGatewayJsonPatch(input: {
  execution: InsightsExecution;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  sessionId: string;
  provider: string;
  model: string;
  allowedProviders: string[];
  allowedModels: string[];
  transcript: string;
  existingEntries: Array<{ id: string; title: string; status: string; evidenceSummary: string }>;
}): Promise<string> {
  const checkpointRunId = input.execution.runId;
  const token = await gatewayTokenService.signRunScopeToken({
    runId: checkpointRunId,
    workspaceId: input.workspaceId,
    targetId: input.targetId,
    targetType: input.targetType,
    sessionId: input.sessionId,
    principal: { type: 'service_identity', id: 'system-target-insights' },
    permissionMode: 'read_only',
    allowedProviders: input.allowedProviders,
    allowedModels: input.allowedModels,
    allowedTools: [],
    allowedNativeTools: [],
    allowedToolOperations: {},
    maxOutputTokens: Math.min(config.LLM_MAX_OUTPUT_TOKENS || 2048, 4096)
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.LLM_GATEWAY_TIMEOUT_MS);
  try {
    const response = await internalFetch(`${config.LLM_GATEWAY_URL}/api/v1/llm/generations:stream`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'x-acornops-execution-owner': input.execution.ownerId,
        'x-acornops-execution-generation': String(input.execution.generation),
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        run_id: checkpointRunId,
        workspace_id: input.workspaceId,
        target_id: input.targetId,
        target_type: input.targetType,
        session_id: input.sessionId,
        provider: input.provider,
        model: input.model,
        temperature: 0,
        max_output_tokens: Math.min(config.LLM_MAX_OUTPUT_TOKENS || 2048, 4096),
        reasoning: { summary_mode: 'off', effort: 'low' },
        messages: [
          {
            role: 'system',
            content: [
              'You maintain durable, target-specific AcornOps troubleshooting knowledge.',
              'Return exactly one JSON object and no markdown or commentary: {"patches":[...]}.',
              'Use create only when the transcript supports reusable learning such as a confirmed cause, remediation, or recurring diagnostic pattern.',
              'Do not create entries for greetings, unanswered symptoms, transient telemetry, provider failures, speculation, run IDs, or raw logs.',
              'Use update or archive only with an exact id from existingEntries. Generalize repeated namespace or host-specific issues only when evidence supports it.',
              'If there is no durable learning, return exactly one noop patch and no other patches.',
              'Patch schema (1-8 patches):',
              '- create: {"action":"create","title":string,"bodyMarkdown":string,"status"?:"active"|"pending","tags"?:string[]_max_32,"evidenceSummary"?:string,"observationCount"?:integer_0_to_100000,"confidence"?:number_0_to_1,"signals"?:object,"scope"?:object}',
              '- update: {"action":"update","entryId":string,<at least one create field except action>}',
              '- archive: {"action":"archive","entryId":string}',
              '- noop: {"action":"noop","reasonCode":"no_durable_learning"|"insufficient_evidence"|"already_captured"}',
              'Unknown fields are invalid. Keep titles and evidence summaries concise.'
            ].join('\n')
          },
          {
            role: 'user',
            content: JSON.stringify({
              existingEntries: input.existingEntries,
              transcript: input.transcript
            })
          }
        ]
      })
    }, config.LLM_GATEWAY_TIMEOUT_MS);
    if (!response.ok || !response.body) {
      throw new Error(`llm-gateway returned ${response.status}`);
    }
    return await readGatewayTextStream(response.body);
  } finally {
    clearTimeout(timeout);
  }
}
