import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { ApiError, parseBody } from '../errors.js';

export const platformRouter = Router();

// Stand-in for the platform operator: a shared key in the x-platform-key header.
export function requirePlatformKey(req, res, next) {
  const given = Buffer.from(req.get('x-platform-key') || '');
  const expected = Buffer.from(config.platformKey);
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) throw new ApiError(401, 'invalid platform key');
  next();
}

const createTenantSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(200),
});

platformRouter.post('/tenants', async (req, res) => {
  const { slug, name } = parseBody(createTenantSchema, req.body);
  const secret = crypto.randomBytes(32).toString('hex');

  const inserted = await query(
    `INSERT INTO tenants (slug, name, signing_secret)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO NOTHING
     RETURNING slug, name, created_at`,
    [slug, name, secret],
  );

  // Created: the secret is shown ONCE, here, and never returned again.
  if (inserted.rowCount === 1) {
    return res.status(201).json({ ...inserted.rows[0], signing_secret: secret });
  }

  // Already exists: a retry is safe and returns the tenant without its secret.
  const existing = await query('SELECT slug, name, created_at FROM tenants WHERE slug = $1', [slug]);
  res.status(200).json(existing.rows[0]);
});

platformRouter.get('/tenants', async (req, res) => {
  const { rows } = await query('SELECT slug, name, created_at FROM tenants ORDER BY created_at');
  res.json(rows);
});