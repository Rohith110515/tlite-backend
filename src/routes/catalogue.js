import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError, parseBody } from '../errors.js';

export const catalogueRouter = Router();

// PostgreSQL error code for "unique constraint violated"
const UNIQUE_VIOLATION = '23505';

/* ---------- Resource types ---------- */

const createTypeSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
});

catalogueRouter.get('/resource-types', async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, description, created_at
       FROM resource_types
      WHERE tenant_id = $1
      ORDER BY name`,
    [req.tenantId], // every query is scoped by the tenant from the verified token
  );
  res.json(rows);
});

catalogueRouter.post('/resource-types', async (req, res) => {
  const body = parseBody(createTypeSchema, req.body);
  try {
    const { rows } = await query(
      `INSERT INTO resource_types (tenant_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, created_at`,
      [req.tenantId, body.name, body.description ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ApiError(409, 'a resource type with this name already exists');
    }
    throw err;
  }
});

/* ---------- Resources ---------- */

const createResourceSchema = z.object({
  resource_type_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  is_exclusive: z.boolean().default(false),
});

catalogueRouter.get('/resources', async (req, res) => {
  const { rows } = await query(
    `SELECT id, resource_type_id, name, is_exclusive, created_at
       FROM resources
      WHERE tenant_id = $1
      ORDER BY name`,
    [req.tenantId],
  );
  res.json(rows);
});

catalogueRouter.post('/resources', async (req, res) => {
  const body = parseBody(createResourceSchema, req.body);

  // The type must exist FOR THIS TENANT. Another tenant's type looks exactly like a missing one.
  const type = await query(
    'SELECT 1 FROM resource_types WHERE id = $1 AND tenant_id = $2',
    [body.resource_type_id, req.tenantId],
  );
  if (type.rowCount === 0) {
    throw new ApiError(404, 'resource type does not exist for your tenant');
  }

  try {
    const { rows } = await query(
      `INSERT INTO resources (tenant_id, resource_type_id, name, is_exclusive)
       VALUES ($1, $2, $3, $4)
       RETURNING id, resource_type_id, name, is_exclusive, created_at`,
      [req.tenantId, body.resource_type_id, body.name, body.is_exclusive],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ApiError(409, 'a resource with this name already exists');
    }
    throw err;
  }
});