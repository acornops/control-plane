import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../auth/middleware.js';
import * as generatedDocumentsController from '../controllers/generated-documents-controller.js';

export const artifactsRouter = Router();

artifactsRouter.get(
  '/report-artifacts/:reportId',
  requireActor(['user', 'externalIntegration']),
  authenticatedHandler(generatedDocumentsController.getGeneratedDocumentMetadata)
);
artifactsRouter.get(
  '/report-artifacts/:reportId/download',
  requireActor(['user', 'externalIntegration']),
  authenticatedHandler(generatedDocumentsController.downloadGeneratedDocument)
);
