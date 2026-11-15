import jwt from 'jsonwebtoken';
import { pool, query } from '../db.js';

const [slug, userId, minutes] = process.argv.slice(2);
if (!slug) {
  console.error('usage: npm run token -- <tenant-slug> [user-id] [minutes]');
  process.exit(1);
}

const { rows } = await query('SELECT signing_secret FROM tenants WHERE slug = $1', [slug]);
if (rows.length === 0) {
  console.error('no such tenant');
  process.exit(1);
}

const payload = { tenant_id: slug, ...(userId ? { on_behalf_of: userId } : {}) };
console.log(
  jwt.sign(payload, rows[0].signing_secret, {
    algorithm: 'HS256',
    audience: 'tarunam',
    expiresIn: `${Number(minutes || 30)}m`,
  }),
);

await pool.end();