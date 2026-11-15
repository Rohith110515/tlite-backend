import express from 'express';
import { authenticate } from './auth.js';
import { errorHandler } from './errors.js'; // Ensure this matches your error handler path
import { healthRouter } from './routes/health.js';
import { platformRouter, requirePlatformKey } from './routes/platform.js';
import { v1Router } from './routes/v1.js';
import { setupSwagger } from './config/swagger.js'; // Swagger UI configuration

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');

  // Every response from the API carries Cache-Control: no-store (as per Tarunam spec)
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Limit request body size to 64 KiB, reject larger with 413
  app.use(express.json({ limit: '64kb' }));

  // Initialize interactive Swagger UI documentation at /api-docs
  setupSwagger(app);

  // API Routes
  app.use('/api', healthRouter);                                    // Public health check (no token needed)
  app.use('/api/v1/platform', requirePlatformKey, platformRouter);    // Platform management routes (platform key)
  app.use('/api/v1', authenticate, v1Router);                         // Tenant-scoped endpoints (JWT Bearer token required)

  // 404 Not Found fallback for unmatched routes
  app.use((req, res) => res.status(404).json({ detail: 'Not Found' }));

  // Global Error Handler
  app.use(errorHandler);

  return app;
}