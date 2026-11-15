import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { ApiError, parseParams, parseQuery } from '../errors.js';
import { effectiveRules } from '../lib/rules.js';
import { BOOKING_SQL } from '../lib/sql.js';

export const bookingsRouter = Router();

const idParams = z.object({ booking_id: z.string().uuid() });
const ATTENDANCE_OPENS_MS = 60 * 60 * 1000; // 60 minutes before the session

async function fetchBooking(db, tenantId, id) {
  const { rows } = await db.query(`${BOOKING_SQL} WHERE b.id = $1 AND b.tenant_id = $2`, [id, tenantId]);
  return rows[0] ?? null;
}

// Locks one booking and reads its session's start time
async function lockBooking(client, tenantId, id) {
  const { rows } = await client.query(
    `SELECT b.id, b.status, s.start_time, s.resource_id
       FROM bookings b
       JOIN schedules s ON s.id = b.schedule_id AND s.tenant_id = b.tenant_id
      WHERE b.id = $1 AND b.tenant_id = $2
        FOR UPDATE OF b`,
    [id, tenantId],
  );
  if (rows.length === 0) throw new ApiError(404, 'booking not found', 'booking_not_found');
  return rows[0];
}

/* ---------- Read ---------- */

const listSchema = z.object({
  user_id: z.string().min(1).max(255),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

bookingsRouter.get('/bookings', async (req, res) => {
  const q = parseQuery(listSchema, req.query);
  if (q.from && q.to && !(new Date(q.to) > new Date(q.from))) {
    throw new ApiError(400, 'to must be after from', 'invalid_time_window');
  }
  const direction = q.order === 'desc' ? 'DESC' : 'ASC'; // from a validated enum, safe to inline

  const { rows } = await query(
    `${BOOKING_SQL}
      WHERE b.tenant_id = $1 AND b.user_id = $2
        AND ($3::timestamptz IS NULL OR s.start_time >= $3)
        AND ($4::timestamptz IS NULL OR s.start_time < $4)
      ORDER BY s.start_time ${direction}, b.created_at
      LIMIT $5`,
    [req.tenantId, q.user_id, q.from ?? null, q.to ?? null, q.limit],
  );
  res.json(rows);
});

bookingsRouter.get('/bookings/:booking_id', async (req, res) => {
  const { booking_id } = parseParams(idParams, req.params);
  const booking = await fetchBooking({ query }, req.tenantId, booking_id);
  if (!booking) throw new ApiError(404, 'booking not found', 'booking_not_found');
  res.json(booking);
});

/* ---------- Cancel ---------- */

bookingsRouter.post('/bookings/:booking_id/cancel', async (req, res) => {
  const { booking_id } = parseParams(idParams, req.params);

  const booking = await withTransaction(async (client) => {
    const b = await lockBooking(client, req.tenantId, booking_id);

    if (b.status === 'cancelled') return fetchBooking(client, req.tenantId, b.id); // unchanged
    if (b.status === 'completed' || b.status === 'no_show') {
      throw new ApiError(409, 'this booking was already attended or marked as a no-show', 'booking_not_cancellable');
    }

    const rules = await effectiveRules(client, req.tenantId, b.resource_id);
    const noticeMs = (rules.min_cancel_notice_minutes ?? 0) * 60000;
    const untilStart = b.start_time.getTime() - Date.now();
    if (untilStart <= 0 || untilStart < noticeMs) {
      throw new ApiError(409, 'cancellation is closed for this session', 'cancellation_closed');
    }

    await client.query(`UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1`, [b.id]);
    return fetchBooking(client, req.tenantId, b.id);
  });
  res.json(booking);
});

/* ---------- Attendance ---------- */

function attendance(newStatus) {
  return async (req, res) => {
    const { booking_id } = parseParams(idParams, req.params);

    const booking = await withTransaction(async (client) => {
      const b = await lockBooking(client, req.tenantId, booking_id);
      if (b.status === 'cancelled') {
        throw new ApiError(409, 'the booking was cancelled', 'booking_cancelled');
      }
      if (b.start_time.getTime() - Date.now() > ATTENDANCE_OPENS_MS) {
        throw new ApiError(409, 'attendance opens 60 minutes before the session', 'attendance_not_open');
      }
      // completed <-> no_show can correct each other
      await client.query(`UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1`, [b.id, newStatus]);
      return fetchBooking(client, req.tenantId, b.id);
    });
    res.json(booking);
  };
}

bookingsRouter.post('/bookings/:booking_id/check-in', attendance('completed'));
bookingsRouter.post('/bookings/:booking_id/no-show', attendance('no_show'));