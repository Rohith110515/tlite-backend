import jwt from 'jsonwebtoken';
import { query } from './db.js';
import { ApiError } from './errors.js';

const AUDIENCE = 'tarunam';
const MAX_LIFETIME_SECONDS = 60 * 60; // max 60 minutes
const LEEWAY_SECONDS = 30; // clock difference tolerance

export async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new ApiError(401, 'missing bearer token');
  }

  const unverified = jwt.decode(token);
  if (!unverified || typeof unverified !== 'object' || typeof unverified.tenant_id !== 'string') {
    throw new ApiError(401, 'malformed token or missing tenant_id claim');
  }

  const { rows } = await query('SELECT slug, signing_secret FROM tenants WHERE slug = $1', [
    unverified.tenant_id,
  ]);
  if (rows.length === 0) throw new ApiError(403, 'tenant does not exist');

  let claims;
  try {
    claims = jwt.verify(token, rows[0].signing_secret, {
      algorithms: ['HS256'], // Pinned algorithm protection
      audience: AUDIENCE,
      clockTolerance: LEEWAY_SECONDS,
    });
  } catch {
    throw new ApiError(401, 'invalid or expired token');
  }

  if (typeof claims.exp !== 'number') throw new ApiError(401, 'token must carry an exp claim');
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp - now > MAX_LIFETIME_SECONDS + LEEWAY_SECONDS) {
    throw new ApiError(401, 'token lifetime is longer than 60 minutes');
  }

  req.tenantId = rows[0].slug;
  req.onBehalfOf = typeof claims.on_behalf_of === 'string' ? claims.on_behalf_of : null;
  next();
}