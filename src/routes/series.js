import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { query, withTransaction } from '../db.js';
import { ApiError, parseBody, parseParams, parseQuery } from '../errors.js';
import { generateSessions, horizonDate, isValidZone } from '../lib/series.js';

export const seriesRouter = Router();

const idParams = z.object({ series_id: z.string().uuid() });

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const datePattern = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => DateTime.fromISO(v).isValid, 'not a real calendar date');

const createSchema = z
  .object({
    resource_id: z.string().uuid(),
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((a) => new Set(a).size === a.length, 'each weekday at most once'),
    start_times: z
      .array(z.string().regex(timePattern, 'use HH:MM'))
      .min(1)
      .max(96)
      .refine((a) => new Set(a).size === a.length, 'each start time at most once'),
    duration_minutes: z.number().int().min(1).max(1440),
    time_zone: z.string().min(1).max(64).refine(isValidZone, 'unknown IANA time zone'),
    capacity: z.number().int().min(1).max(100000).default(1),
    starts_on: datePattern.nullish(),
    ends_on: datePattern.nullish(),
  })
  .refine((b) => !b.starts_on || !b.ends_on || b.ends_on >= b.starts_on, {
    message: 'ends_on must not be before starts_on',
    path: ['ends_on'],
  });

const seriesOut = (r) => ({
  id: r.id,
  resource_id: r.resource_id,
  weekdays: r.weekdays,
  start_times: r.start_times,
  duration_minutes: r.duration_minutes,
  capacity: r.capacity,
  time_zone: r.time_zone,
  starts_on: r.starts_on,
  ends_on: r.ends_on,
  generated_through: r.generated_through,
  status: r.status,
});

seriesRouter.post('/series', async (req, res) => {
  const b = parseBody(createSchema, req.body);

  const resource = await query('SELECT 1 FROM resources WHERE id = $1 AND tenant_id = $2', [
    b.resource_id,
    req.tenantId,
  ]);
  if (resource.rowCount === 0) throw new ApiError(404, 'resource does not exist for your tenant');

  const startsOn = b.starts_on ?? DateTime.now().setZone(b.time_zone).toISODate();
  const endsOn = b.ends_on ?? null;
  const target = horizonDate({ starts_on: startsOn, ends_on: endsOn }, b.time_zone);

  const created = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO series
         (tenant_id, resource_id, weekdays, start_times, duration_minutes, capacity,
          time_zone, starts_on, ends_on, generated_through)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.tenantId, b.resource_id, b.weekdays, b.start_times, b.duration_minutes,
       b.capacity, b.time_zone, startsOn, endsOn, target],
    );
    const sessions = await generateSessions(client, rows[0], startsOn, target);
    return { ...seriesOut(rows[0]), sessions_created: sessions };
  });
  res.status(201).json(created);
});

const listSchema = z.object({ resource_id: z.string().uuid().optional() });

seriesRouter.get('/series', async (req, res) => {
  const q = parseQuery(listSchema, req.query);
  const { rows } = await query(
    `SELECT * FROM series
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR resource_id = $2)
      ORDER BY created_at DESC`,
    [req.tenantId, q.resource_id ?? null],
  );
  res.json(rows.map(seriesOut));
});

const stopSchema = z.object({ cancel_future_sessions: z.boolean().default(false) });

seriesRouter.post('/series/:series_id/stop', async (req, res) => {
  const { series_id } = parseParams(idParams, req.params);
  const body = parseBody(stopSchema, req.body);

  const result = await withTransaction(async (client) => {
    const locked = await client.query(
      `SELECT id FROM series WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [series_id, req.tenantId],
    );
    if (locked.rowCount === 0) throw new ApiError(404, 'series not found', 'series_not_found');

    await client.query(`UPDATE series SET status = 'stopped' WHERE id = $1`, [series_id]);

    let sessions = 0;
    let bookings = 0;
    if (body.cancel_future_sessions) {
      const cancelled = await client.query(
        `WITH s AS (
           UPDATE schedules SET status = 'cancelled'
            WHERE series_id = $1 AND tenant_id = $2 AND status = 'open' AND start_time > now()
            RETURNING id
         ), b AS (
           UPDATE bookings SET status = 'cancelled', updated_at = now()
            WHERE schedule_id IN (SELECT id FROM s) AND status = 'confirmed'
            RETURNING id
         )
         SELECT (SELECT count(*) FROM s)::int AS sessions, (SELECT count(*) FROM b)::int AS bookings`,
        [series_id, req.tenantId],
      );
      sessions = cancelled.rows[0].sessions;
      bookings = cancelled.rows[0].bookings;
    }
    return { series_id, status: 'stopped', sessions_cancelled: sessions, bookings_cancelled: bookings };
  });
  res.json(result);
});