import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../auth/middleware.js';
import * as generatedDocumentsController from '../controllers/generated-documents-controller.js';

export const artifactsRouter = Router();

artifactsRouter.get(
  '/generated-documents/:documentId',
  requireActor(['user', 'externalIntegration']),
  authenticatedHandler(generatedDocumentsController.getGeneratedDocumentMetadata)
);
artifactsRouter.get(
  '/generated-documents/:documentId/download',
  requireActor(['user', 'externalIntegration']),
  authenticatedHandler(generatedDocumentsController.downloadGeneratedDocument)
);
