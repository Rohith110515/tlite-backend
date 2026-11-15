import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { ApiError, parseBody, parseParams, parseQuery } from '../errors.js';
import { effectiveRules } from '../lib/rules.js';
import { BOOKING_SQL, SCHEDULE_DETAIL_SQL } from '../lib/sql.js';

export const schedulesRouter = Router();

const UNIQUE_VIOLATION = '23505';
const EXCLUSION_VIOLATION = '23P01'; // the overlap constraint
const DAY_MS = 86400000;

const scheduleParams = z.object({ schedule_id: z.string().uuid() });
const resourceParams = z.object({ resource_id: z.string().uuid() });

const inRange = (v) => {
  const y = new Date(v).getUTCFullYear();
  return y >= 1970 && y <= 2999;
};
const when = z.string().datetime({ offset: true }).refine(inRange, 'year must be between 1970 and 2999');

function invalidWindow() {
  return new ApiError(400, 'to must be after from, and the window at most 93 days', 'invalid_time_window');
}

/* ---------- Create ---------- */

const createSchema = z.object({
  resource_id: z.string().uuid(),
  start_time: when,
  end_time: when,
  capacity: z.number().int().min(1).max(100000).default(1),
});

schedulesRouter.post('/schedules', async (req, res) => {
  const body = parseBody(createSchema, req.body);
  if (!(new Date(body.end_time) > new Date(body.start_time))) {
    throw new ApiError(400, 'end_time must be after start_time');
  }

  const resource = await query('SELECT 1 FROM resources WHERE id = $1 AND tenant_id = $2', [
    body.resource_id,
    req.tenantId,
  ]);
  if (resource.rowCount === 0) throw new ApiError(404, 'resource does not exist for your tenant');

  try {
    const { rows } = await query(
      `INSERT INTO schedules (tenant_id, resource_id, start_time, end_time, capacity)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, resource_id, start_time, end_time, capacity, status`,
      [req.tenantId, body.resource_id, body.start_time, body.end_time, body.capacity],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    // The database refused the overlap, so concurrent requests cannot both succeed
    if (err.code === EXCLUSION_VIOLATION) {
      throw new ApiError(409, 'time range overlaps an existing session for this resource');
    }
    throw err;
  }
});

/* ---------- Read ---------- */

const listSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  resource_id: z.string().uuid().optional(),
  include_cancelled: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

schedulesRouter.get('/schedules', async (req, res) => {
  const q = parseQuery(listSchema, req.query);
  const from = q.from ? new Date(q.from) : new Date();
  const to = q.to ? new Date(q.to) : new Date(from.getTime() + 14 * DAY_MS);
  if (!(to > from) || to - from > 93 * DAY_MS) throw invalidWindow();

  const { rows } = await query(
    `${SCHEDULE_DETAIL_SQL}
      WHERE s.tenant_id = $1
        AND s.start_time >= $2 AND s.start_time < $3
        AND ($4::uuid IS NULL OR s.resource_id = $4)
        AND ($5 OR s.status = 'open')
      ORDER BY s.start_time
      LIMIT $6`,
    [req.tenantId, from, to, q.resource_id ?? null, q.include_cancelled, q.limit],
  );
  res.json(rows);
});

schedulesRouter.get('/schedules/:schedule_id', async (req, res) => {
  const { schedule_id } = parseParams(scheduleParams, req.params);
  const { rows } = await query(`${SCHEDULE_DETAIL_SQL} WHERE s.id = $1 AND s.tenant_id = $2`, [
    schedule_id,
    req.tenantId,
  ]);
  if (rows.length === 0) throw new ApiError(404, 'schedule not found', 'schedule_not_found');
  res.json(rows[0]);
});

schedulesRouter.get('/resources/:resource_id/schedules', async (req, res) => {
  const { resource_id } = parseParams(resourceParams, req.params);
  const { rows } = await query(
    `SELECT id, resource_id, start_time, end_time, capacity, status
       FROM schedules
      WHERE resource_id = $1 AND tenant_id = $2 AND status = 'open'
      ORDER BY start_time`,
    [resource_id, req.tenantId],
  );
  res.json(rows); // empty list when none, or when the resource belongs to another tenant
});

schedulesRouter.get('/schedules/:schedule_id/bookings', async (req, res) => {
  const { schedule_id } = parseParams(scheduleParams, req.params);
  const exists = await query('SELECT 1 FROM schedules WHERE id = $1 AND tenant_id = $2', [
    schedule_id,
    req.tenantId,
  ]);
  if (exists.rowCount === 0) throw new ApiError(404, 'schedule not found', 'schedule_not_found');

  const { rows } = await query(
    `${BOOKING_SQL} WHERE b.schedule_id = $1 AND b.tenant_id = $2 ORDER BY b.created_at`,
    [schedule_id, req.tenantId],
  );
  res.json(rows);
});

/* ---------- Call off a session ---------- */

schedulesRouter.post('/schedules/:schedule_id/cancel', async (req, res) => {
  const { schedule_id } = parseParams(scheduleParams, req.params);

  const result = await withTransaction(async (client) => {
    const locked = await client.query(
      `SELECT id, status, end_time FROM schedules WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [schedule_id, req.tenantId],
    );
    if (locked.rowCount === 0) throw new ApiError(404, 'schedule not found', 'schedule_not_found');
    const s = locked.rows[0];

    if (s.status === 'cancelled') return { schedule_id: s.id, status: 'cancelled', bookings_cancelled: 0 };
    if (s.end_time.getTime() <= Date.now()) {
      throw new ApiError(409, 'schedule has ended', 'schedule_ended');
    }

    await client.query(`UPDATE schedules SET status = 'cancelled' WHERE id = $1`, [s.id]);
    const cancelled = await client.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = now()
        WHERE schedule_id = $1 AND status = 'confirmed'`,
      [s.id],
    );
    return { schedule_id: s.id, status: 'cancelled', bookings_cancelled: cancelled.rowCount };
  });
  res.json(result);
});

/* ---------- Book a session (the critical endpoint) ---------- */

const bookSchema = z.object({
  user_id: z.string().min(1).max(255).nullish(),
  guests: z.number().int().min(1).max(100000).default(1),
  idempotency_key: z.string().min(1).max(255).nullish(),
});

async function findByKey(db, tenantId, key) {
  const { rows } = await db.query(
    `SELECT id, schedule_id, user_id, guests, status
       FROM bookings WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, key],
  );
  return rows[0] ?? null;
}

function keyReused() {
  return new ApiError(409, 'idempotency key was used on another schedule', 'idempotency_key_reused');
}

schedulesRouter.post('/schedules/:schedule_id/book', async (req, res) => {
  const { schedule_id } = parseParams(scheduleParams, req.params);
  const body = parseBody(bookSchema, req.body);
  const userId = body.user_id ?? req.onBehalfOf;
  if (!userId) {
    throw new ApiError(400, 'user_id is required when the token has no on_behalf_of claim');
  }
  const key = body.idempotency_key ?? null;

  let booking;
  try {
    booking = await withTransaction(async (client) => {
      // 1. Lock the session row. Concurrent bookings of this session now queue up here,
      //    so the seat count read below cannot change under us.
      const locked = await client.query(
        `SELECT id, resource_id, start_time, status, capacity
           FROM schedules WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [schedule_id, req.tenantId],
      );
      if (locked.rowCount === 0) throw new ApiError(404, 'schedule not found', 'schedule_not_found');
      const schedule = locked.rows[0];

      // 2. Idempotency: a repeated key returns the original booking, unchanged
      if (key) {
        const prior = await findByKey(client, req.tenantId, key);
        if (prior) {
          if (prior.schedule_id !== schedule.id) throw keyReused();
          return prior;
        }
      }

      // 3. State checks
      if (schedule.status !== 'open') {
        throw new ApiError(409, 'schedule was called off', 'schedule_not_open');
      }
      const now = Date.now();
      const startMs = schedule.start_time.getTime();
      if (startMs <= now) throw new ApiError(409, 'schedule has started', 'schedule_started');

      // 4. Rules: the resource's own rule set, or else the tenant settings
      const rules = await effectiveRules(client, req.tenantId, schedule.resource_id);
      const minutesAhead = (startMs - now) / 60000;
      if (rules.min_lead_minutes != null && minutesAhead < rules.min_lead_minutes) {
        throw new ApiError(409, 'booking is closed for this session', 'booking_closed');
      }
      if (rules.max_horizon_minutes != null && minutesAhead > rules.max_horizon_minutes) {
        throw new ApiError(409, 'booking is not open yet for this session', 'booking_not_open_yet');
      }

      // 5. Capacity: guests held by every booking that is not cancelled
      const seats = await client.query(
        `SELECT COALESCE(SUM(guests), 0)::int AS booked
           FROM bookings WHERE schedule_id = $1 AND status <> 'cancelled'`,
        [schedule.id],
      );
      if (seats.rows[0].booked + body.guests > schedule.capacity) {
        throw new ApiError(409, 'not enough seats left', 'schedule_full');
      }

      // 6. Insert
      const inserted = await client.query(
        `INSERT INTO bookings (tenant_id, schedule_id, user_id, guests, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, schedule_id, user_id, guests, status`,
        [req.tenantId, schedule.id, userId, body.guests, key],
      );
      return inserted.rows[0];
    });
  } catch (err) {
    // Two requests with the same new key hit DIFFERENT sessions at the same moment:
    // the unique index let only one win, so resolve the loser here.
    if (err.code === UNIQUE_VIOLATION && key) {
      const prior = await findByKey({ query }, req.tenantId, key);
      if (!prior) throw err;
      if (prior.schedule_id !== schedule_id) throw keyReused();
      booking = prior;
    } else {
      throw err;
    }
  }

  res.status(201).json({
    booking_id: booking.id,
    schedule_id: booking.schedule_id,
    user_id: booking.user_id,
    guests: booking.guests,
    status: booking.status,
  });
});