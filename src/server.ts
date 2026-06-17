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
import {
  registerRunEventHandler,
  startControlPlaneCoordination,
  stopControlPlaneCoordination,
  withRedisLease
} from './services/control-plane-coordination.js';
import { expireAndResumeTimedOutApprovals } from './services/approval-timeouts.js';
import { syncTargetBuiltInTools } from './services/target-built-in-tool-sync.js';
import { runControlPlaneRetentionSweep } from './services/conversation-retention.js';
import { ensureDevelopmentMcpSeed } from './services/development-mcp-seed.js';
import { repo } from './store/repository.js';
import { runtime } from './store/runtime.js';
import { KUBERNETES_TARGET_TYPE, VIRTUAL_MACHINE_TARGET_TYPE } from './types/domain.js';

async function main(): Promise<void> {
  await initializeDatabase();
  await repo.syncRoleTemplates(config.WORKSPACE_ROLE_TEMPLATES);
  await initializeRedis();
  registerRunEventHandler(({ runId, events }) => {
    for (const event of events) {
      runtime.runStreams.emit(`run:${runId}`, { event });
    }
  });
  await startControlPlaneCoordination();
  if (config.SEED_DEVELOPMENT_DATA) {
    await repo.ensureDevelopmentSeed(config.SEED_AGENT_KEY, config.SEED_VM_AGENT_KEY);
    await ensureDevelopmentMcpSeed();
    await syncTargetBuiltInTools(DEVELOPMENT_WORKSPACE_ID, DEVELOPMENT_CLUSTER_ID, KUBERNETES_TARGET_TYPE);
    await syncTargetBuiltInTools(DEVELOPMENT_WORKSPACE_ID, DEVELOPMENT_VM_ID, VIRTUAL_MACHINE_TARGET_TYPE);
  }

  const app = createApp();
  const server = createServer(app);
  const internalServer = config.INTERNAL_TRANSPORT_TLS_ENABLED
    ? createHttpsServer(internalServerTlsOptions(), createInternalApp())
    : undefined;
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
          if (!result.ok || result.registeredToolCount === 0) {
            failed += 1;
            continue;
          }
          synced += 1;
        }
        if (failed > 0) {
          logger.warn({ synced, failed, total: regs.length }, 'Periodic built-in tool sync completed with failures');
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
  }, Math.max(5, Math.min(config.AGENT_WRITE_CONFIRMATION_TIMEOUT_SECONDS, 60)) * 1000);
  approvalTimeoutInterval.unref();

  server.on('upgrade', (request, socket, head) => {
    const handled = agentGateway.handleUpgrade(request, socket, head);
    if (!handled) {
      socket.destroy();
    }
  });

  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'AcornOps control plane started');
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
