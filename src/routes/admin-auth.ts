import { Router } from 'express';
import * as controller from '../controllers/admin-auth-controller.js';
import { incrementAdminRequests } from '../metrics.js';

export const adminAuthRouter = Router();
adminAuthRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.on('finish', () => incrementAdminRequests(req.method, `/admin-auth${req.route?.path ? String(req.route.path) : req.path}`, res.statusCode));
  next();
});
adminAuthRouter.get('/oidc/login', controller.login);
adminAuthRouter.get('/oidc/callback', controller.callback);
adminAuthRouter.get('/csrf', controller.csrf);
adminAuthRouter.post('/logout', controller.logout);
