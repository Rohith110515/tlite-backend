import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  console.log('running', file);
  await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
}

await pool.end();
console.log('migrations done');