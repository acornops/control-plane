import { assertWorkspaceCapacityRollout } from './services/workspace-capacity-rollout.js';
import { runWorkspaceCapacityMaintenance } from './services/workspace-capacity-maintenance.js';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { agentGateway } from './agent/ws-server.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { DEVELOPMENT_CLUSTER_ID, DEVELOPMENT_VM_ID, DEVELOPMENT_WORKSPACE_ID } from './constants/dev-defaults.js';
import { closeDatabase, initializeDatabase } from './infra/db.js';
import { internalServerTlsOptions } from './infra/internal-tls.js';
import { closeRedis, initializeRedis } from './infra/redis.js';
import { createInternalApp } from './internal-app.js';
import { logger } from './logger.js';
import { setMcpUserLifecycleGauges } from './metrics.js';
import {
  registerRunEventHandler,
  registerTargetChatActivityEventHandler,
  registerWorkflowExecutionEventHandler,
  startControlPlaneCoordination,
  stopControlPlaneCoordination,
  withRedisLease
} from './services/control-plane-coordination.js';
import { emitTargetChatActivityEvent } from './services/target-chat-activity-events.js';
import { expireAndResumeTimedOutApprovals } from './services/approval-timeouts.js';
import { syncTargetBuiltInTools } from './services/target-built-in-tool-sync.js';
import { syncAgentTargetsBuiltInTools } from './services/agent-targets-mcp-sync.js';
import { runControlPlaneRetentionSweep } from './services/conversation-retention.js';
import { runTargetInsightsCheckpointSweep } from './services/target-insights/checkpoint-worker.js';
import { runWebhookDeliverySweep } from './services/webhook-worker.js';
import { runAutomationOutboxTick } from './services/automation-outbox-worker.js';
import { runWorkflowScheduleTick } from './services/workflow-scheduler.js';
import { runWorkflowWebhookTick } from './services/workflow-webhook-worker.js';
import { refreshAutomationMetricsSnapshot } from './services/automation-diagnostics.js';
import { repo } from './store/repository.js';
import { listAgentDefinitionRefs } from './store/repository-agents.js';
import { runtime } from './store/runtime.js';
import { KUBERNETES_TARGET_TYPE, VIRTUAL_MACHINE_TARGET_TYPE } from './types/domain.js';
import { runMcpUserLifecycleReconciliationTick } from './services/mcp-user-lifecycle-worker.js';
import { deleteExpiredMcpOAuthCorrelations } from './store/repository-mcp-oauth-correlations.js';
import { getMcpUserLifecycleReconciliationBacklog } from './store/repository-mcp-user-lifecycle.js';
import {
  runTargetAutoTriageTick,
  TARGET_AUTO_TRIAGE_WORKER_INTERVAL_MS
} from './services/auto-triage-worker.js';
import {
  initializePlatformSettings,
  startPlatformSettingsRefresh,
  stopPlatformSettingsRefresh
} from './services/platform-settings.js';

async function main(): Promise<void> {
  await initializeDatabase();
  await assertWorkspaceCapacityRollout();
  await repo.ensureOidcPrelinkedIdentities(
    config.OIDC_PROVIDER_NAME,
    config.OIDC_PRELINKED_IDENTITIES_JSON
  );
  await repo.syncRoleTemplates(config.WORKSPACE_ROLE_TEMPLATES);
  await initializePlatformSettings();
  await initializeRedis();
  await startPlatformSettingsRefresh();
  registerRunEventHandler(({ runId, events }) => {
    for (const event of events) {
      runtime.runStreams.emit(`run:${runId}`, { event });
    }
  });
  registerTargetChatActivityEventHandler(({ events }) => {
    for (const event of events) {
      emitTargetChatActivityEvent(event);
    }
  });
  registerWorkflowExecutionEventHandler(({ executionId, events }) => {
    for (const event of events) {
      runtime.workflowExecutionStreams.emit(`workflow-execution:${executionId}`, { event });
    }
  });
  await startControlPlaneCoordination();
  if (config.SEED_DEVELOPMENT_DATA) {
    await repo.ensureDevelopmentTargetSeed(config.SEED_AGENT_KEY, config.SEED_VM_AGENT_KEY);
    await syncTargetBuiltInTools(DEVELOPMENT_WORKSPACE_ID, DEVELOPMENT_CLUSTER_ID, KUBERNETES_TARGET_TYPE);
    await syncTargetBuiltInTools(DEVELOPMENT_WORKSPACE_ID, DEVELOPMENT_VM_ID, VIRTUAL_MACHINE_TARGET_TYPE);
  }

  const app = createApp();
  const server = createServer(app);
  const internalServer = config.INTERNAL_TRANSPORT_TLS_ENABLED
    ? createHttpsServer(internalServerTlsOptions(), createInternalApp())
    : undefined;
  let mcpLifecycleReconciliationInFlight = false;
  const runMcpLifecycleReconciliation = async () => {
    if (mcpLifecycleReconciliationInFlight) return;
    mcpLifecycleReconciliationInFlight = true;
    try {
      await Promise.all([
        runMcpUserLifecycleReconciliationTick().catch((err) => {
          logger.warn({ err }, 'MCP user lifecycle reconciliation tick failed');
        }),
        deleteExpiredMcpOAuthCorrelations().catch((err) => {
          logger.warn({ err }, 'Expired MCP OAuth correlation cleanup failed');
        })
      ]);
      setMcpUserLifecycleGauges(await getMcpUserLifecycleReconciliationBacklog());
    } catch (err) {
      logger.warn({ err }, 'MCP lifecycle reconciliation metrics refresh failed');
    } finally {
      mcpLifecycleReconciliationInFlight = false;
    }
  };
  const mcpLifecycleReconciliationInterval = setInterval(runMcpLifecycleReconciliation, 1_000);
  mcpLifecycleReconciliationInterval.unref();
  let retentionSweepInFlight = false;
  const runRetentionSweep = async () => {
    if (retentionSweepInFlight) return;
    retentionSweepInFlight = true;
    try {
      await withRedisLease('conversation-retention', 300, async () => {
        await runControlPlaneRetentionSweep();
      });
    } catch (err) {
      logger.warn({ err }, 'Conversation retention sweep failed');
    } finally {
      retentionSweepInFlight = false;
    }
  };
  await runRetentionSweep();

  const toolingSyncInterval = setInterval(async () => {
    try {
      await withRedisLease('built-in-tool-sync', 120, async () => {
        const regs = await repo.listTargetAgentRegistrations();
        let synced = 0;
        let failed = 0;
        for (const reg of regs) {
          const result = await syncTargetBuiltInTools(reg.workspaceId, reg.targetId, reg.targetType);
          if (result.terminal) continue;
          if (!result.ok || result.registeredToolCount === 0) {
            failed += 1;
            continue;
          }
          synced += 1;
        }
        const agents = await listAgentDefinitionRefs();
        let agentsSynced = 0;
        let agentsFailed = 0;
        for (const agent of agents) {
          const result = await syncAgentTargetsBuiltInTools(agent.workspaceId, agent.agentId);
          if (result.terminal) continue;
          if (!result.ok || result.registeredToolCount === 0) {
            agentsFailed += 1;
            continue;
          }
          agentsSynced += 1;
        }
        if (failed > 0 || agentsFailed > 0) {
          logger.warn({
            targets: { synced, failed, total: regs.length },
            agents: { synced: agentsSynced, failed: agentsFailed, total: agents.length }
          }, 'Periodic built-in tool sync completed with failures');
        }
      });
    } catch (err) {
      logger.warn({ err }, 'Periodic built-in tool sync failed');
    }
  }, 60_000);
  const conversationRetentionInterval = setInterval(
    runRetentionSweep,
    config.CONVERSATION_RETENTION_JOB_INTERVAL_SECONDS * 1000
  );
  conversationRetentionInterval.unref();
  const approvalTimeoutInterval = setInterval(async () => {
    try {
      await withRedisLease('approval-timeouts', 30, async () => {
        await expireAndResumeTimedOutApprovals();
      });
    } catch (err) {
      logger.warn({ err }, 'Approval timeout sweep failed');
    }
  }, Math.max(5, Math.min(config.ASSISTANT_WRITE_CONFIRMATION_TIMEOUT_SECONDS, 60)) * 1000);
  approvalTimeoutInterval.unref();
  const targetInsightsCheckpointInterval = setInterval(async () => {
    try {
      await withRedisLease('target-insights-checkpoints', 120, async () => {
        await runTargetInsightsCheckpointSweep();
      });
    } catch (err) {
      logger.warn({ err }, 'Target Insights checkpoint sweep failed');
    }
  }, 60_000);
  targetInsightsCheckpointInterval.unref();
  const capacityMaintenanceInterval = setInterval(() => {
    void runWorkspaceCapacityMaintenance().catch((err) => logger.warn({ err }, 'Workspace capacity maintenance failed'));
  }, 10000);
  capacityMaintenanceInterval.unref();
  const automationWorkerInterval = setInterval(async () => {
    try {
      await runWorkflowScheduleTick();
      await runWorkflowWebhookTick();
      await runAutomationOutboxTick();
      await refreshAutomationMetricsSnapshot();
    } catch (err) {
      logger.warn({ err }, 'Automation worker tick failed');
    }
  }, config.AUTOMATION_WORKER_INTERVAL_MS);
  automationWorkerInterval.unref();
  const agentVEnrollmentCleanupInterval = setInterval(async () => {
    try {
      await withRedisLease('agentv-enrollment-cleanup', 60, async () => {
        await repo.agentv.expireAgentVEnrollmentState();
      });
    } catch (err) {
      logger.warn({ err }, 'AgentV enrollment cleanup failed');
    }
  }, 60_000);
  agentVEnrollmentCleanupInterval.unref();
  let targetAutoTriageTickInFlight = false;
  const targetAutoTriageWorkerInterval = setInterval(async () => {
    if (targetAutoTriageTickInFlight) return;
    targetAutoTriageTickInFlight = true;
    try {
      await runTargetAutoTriageTick();
    } catch (err) {
      logger.warn({ err }, 'Target auto-triage worker tick failed');
    } finally {
      targetAutoTriageTickInFlight = false;
    }
  }, TARGET_AUTO_TRIAGE_WORKER_INTERVAL_MS);
  targetAutoTriageWorkerInterval.unref();
  let webhookSweepInFlight = false;
  const webhookDeliveryInterval = setInterval(async () => {
    if (webhookSweepInFlight) return;
    webhookSweepInFlight = true;
    try {
      await runWebhookDeliverySweep();
    } finally {
      webhookSweepInFlight = false;
    }
  }, 1000);
  webhookDeliveryInterval.unref();

  server.on('upgrade', (request, socket, head) => {
    const handled = agentGateway.handleUpgrade(request, socket, head);
    if (!handled) {
      socket.destroy();
    }
  });

  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'AcornOps control plane started');
    void runMcpLifecycleReconciliation();
  });
  if (internalServer) {
    internalServer.listen(config.CONTROL_PLANE_INTERNAL_TRANSPORT_PORT, () => {
      logger.info(
        {
          port: config.CONTROL_PLANE_INTERNAL_TRANSPORT_PORT,
          requireClientCert: config.INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT
        },
        'AcornOps control plane internal transport started'
      );
    });
  }

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Shutting down control plane...');
    clearInterval(toolingSyncInterval);
    clearInterval(conversationRetentionInterval);
    clearInterval(approvalTimeoutInterval);
    clearInterval(targetInsightsCheckpointInterval);
    clearInterval(automationWorkerInterval);
    clearInterval(capacityMaintenanceInterval);
    clearInterval(mcpLifecycleReconciliationInterval);
    clearInterval(agentVEnrollmentCleanupInterval);
    clearInterval(targetAutoTriageWorkerInterval);
    clearInterval(webhookDeliveryInterval);
    const forceExit = setTimeout(() => {
      logger.error('Forced control plane shutdown after timeout');
      process.exit(1);
    }, 30000);
    forceExit.unref();
    await agentGateway.shutdown().catch((err) => {
      logger.warn({ err }, 'Agent gateway shutdown failed');
    });
    const closeInternalServer = async () => {
      if (!internalServer) return;
      await new Promise<void>((resolve) => internalServer.close(() => resolve()));
    };
    server.close(async () => {
      await closeInternalServer().catch((err) => {
        logger.warn({ err }, 'Internal transport shutdown failed');
      });
      await stopControlPlaneCoordination().catch(() => undefined);
      await stopPlatformSettingsRefresh().catch(() => undefined);
      await closeRedis().catch(() => undefined);
      await closeDatabase().catch(() => undefined);
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start control plane');
  process.exit(1);
});
