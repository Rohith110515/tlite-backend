import { Router } from 'express';
import { query } from '../db.js';

export const healthRouter = Router();


healthRouter.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', service: 'tarunam-lite', db: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', service: 'tarunam-lite', db: 'unreachable' });
  }
});