import { DateTime } from 'luxon';
import { pool } from '../db.js';

const WINDOW_DAYS = 56; // sessions are created about eight weeks ahead

export function isValidZone(zone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The last local date (YYYY-MM-DD) sessions should exist for.
export function horizonDate(series, zone) {
  const today = DateTime.now().setZone(zone).startOf('day');
  const starts = DateTime.fromISO(series.starts_on, { zone });
  const base = today > starts ? today : starts;
  let target = base.plus({ days: WINDOW_DAYS });
  if (series.ends_on) {
    const ends = DateTime.fromISO(series.ends_on, { zone });
    if (ends < target) target = ends;
  }
  return target.toISODate();
}

// Inserts sessions for local dates fromDate..throughDate (inclusive).
// Past sessions, and sessions that would overlap an existing one, are skipped.
export async function generateSessions(db, series, fromDate, throughDate) {
  const zone = series.time_zone;
  const now = Date.now();
  let created = 0;
  let day = DateTime.fromISO(fromDate, { zone });
  const last = DateTime.fromISO(throughDate, { zone });

  while (day <= last) {
    if (series.weekdays.includes(day.weekday)) { // luxon: 1 = Monday ... 7 = Sunday
      for (const time of series.start_times) {
        const [hour, minute] = time.split(':').map(Number);
        const start = day.set({ hour, minute, second: 0, millisecond: 0 });
        if (!start.isValid || start.toMillis() <= now) continue;
        const end = start.plus({ minutes: series.duration_minutes });

        // ON CONFLICT DO NOTHING also covers the overlap (exclusion) constraint
        const result = await db.query(
          `INSERT INTO schedules (tenant_id, resource_id, series_id, start_time, end_time, capacity)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [series.tenant_id, series.resource_id, series.id, start.toUTC().toISO(), end.toUTC().toISO(), series.capacity],
        );
        created += result.rowCount;
      }
    }
    day = day.plus({ days: 1 });
  }
  return created;
}

// Called at startup and every hour: extends every active series to its horizon.
export async function topUpAllSeries() {
  const { rows } = await pool.query(`SELECT * FROM series WHERE status = 'active'`);
  let created = 0;
  for (const series of rows) {
    const target = horizonDate(series, series.time_zone);
    const from = DateTime.fromISO(series.generated_through, { zone: series.time_zone })
      .plus({ days: 1 })
      .toISODate();
    if (from > target) continue; // ISO dates compare correctly as strings
    created += await generateSessions(pool, series, from, target);
    await pool.query('UPDATE series SET generated_through = $1 WHERE id = $2', [target, series.id]);
  }
  return created;
}