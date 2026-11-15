import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError, parseBody, parseParams } from '../errors.js';

export const rulesRouter = Router();

const MAX = 5256000;
const idParams = z.object({ resource_id: z.string().uuid() });

const rulesSchema = z.object({
  min_lead_minutes: z.number().int().min(0).max(MAX).default(0),
  max_horizon_minutes: z.number().int().min(1).max(MAX).default(10080),
  max_duration_minutes: z.number().int().min(1).max(MAX).default(1440),
  max_capacity: z.number().int().min(1).max(100000).default(1),
  min_cancel_notice_minutes: z.number().int().min(0).max(MAX).default(0),
});

const RULE_COLUMNS = `resource_id, min_lead_minutes, max_horizon_minutes,
  max_duration_minutes, max_capacity, min_cancel_notice_minutes`;

// Replaces the rule set; any field left out goes back to its default
rulesRouter.post('/resources/:resource_id/rules', async (req, res) => {
  const { resource_id } = parseParams(idParams, req.params);
  const r = parseBody(rulesSchema, req.body);

  const found = await query('SELECT 1 FROM resources WHERE id = $1 AND tenant_id = $2', [
    resource_id,
    req.tenantId,
  ]);
  if (found.rowCount === 0) throw new ApiError(404, 'resource does not exist for your tenant');

  const { rows } = await query(
    `INSERT INTO resource_rules
       (resource_id, tenant_id, min_lead_minutes, max_horizon_minutes,
        max_duration_minutes, max_capacity, min_cancel_notice_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (resource_id) DO UPDATE SET
       min_lead_minutes = EXCLUDED.min_lead_minutes,
       max_horizon_minutes = EXCLUDED.max_horizon_minutes,
       max_duration_minutes = EXCLUDED.max_duration_minutes,
       max_capacity = EXCLUDED.max_capacity,
       min_cancel_notice_minutes = EXCLUDED.min_cancel_notice_minutes
     RETURNING ${RULE_COLUMNS}`,
    [
      resource_id,
      req.tenantId,
      r.min_lead_minutes,
      r.max_horizon_minutes,
      r.max_duration_minutes,
      r.max_capacity,
      r.min_cancel_notice_minutes,
    ],
  );
  res.status(201).json(rows[0]);
});

rulesRouter.get('/resources/:resource_id/rules', async (req, res) => {
  const { resource_id } = parseParams(idParams, req.params);
  const { rows } = await query(
    `SELECT ${RULE_COLUMNS} FROM resource_rules WHERE resource_id = $1 AND tenant_id = $2`,
    [resource_id, req.tenantId],
  );
  if (rows.length === 0) throw new ApiError(404, 'no rule set has been stored for this resource');
  res.json(rows[0]);
});

/* ---------- Tenant-wide booking settings ---------- */

const settingsSchema = z.object({
  min_lead_minutes: z.number().int().min(0).max(MAX).nullish(),
  max_horizon_minutes: z.number().int().min(1).max(MAX).nullish(),
  min_cancel_notice_minutes: z.number().int().min(0).max(MAX).nullish(),
});

rulesRouter.get('/settings', async (req, res) => {
  const { rows } = await query(
    `SELECT min_lead_minutes, max_horizon_minutes, min_cancel_notice_minutes
       FROM tenant_settings WHERE tenant_id = $1`,
    [req.tenantId],
  );
  res.json(
    rows[0] ?? { min_lead_minutes: null, max_horizon_minutes: null, min_cancel_notice_minutes: null },
  );
});

// Replaces all three; a field left out (or null) is no longer enforced
rulesRouter.put('/settings', async (req, res) => {
  const s = parseBody(settingsSchema, req.body);
  const { rows } = await query(
    `INSERT INTO tenant_settings (tenant_id, min_lead_minutes, max_horizon_minutes, min_cancel_notice_minutes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id) DO UPDATE SET
       min_lead_minutes = EXCLUDED.min_lead_minutes,
       max_horizon_minutes = EXCLUDED.max_horizon_minutes,
       min_cancel_notice_minutes = EXCLUDED.min_cancel_notice_minutes
     RETURNING min_lead_minutes, max_horizon_minutes, min_cancel_notice_minutes`,
    [req.tenantId, s.min_lead_minutes ?? null, s.max_horizon_minutes ?? null, s.min_cancel_notice_minutes ?? null],
  );
  res.json(rows[0]);
});