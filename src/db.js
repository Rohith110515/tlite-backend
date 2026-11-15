import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Date objects
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export function query(text, params) {
  return pool.query(text, params);
}

// Runs fn(client) inside one transaction.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}