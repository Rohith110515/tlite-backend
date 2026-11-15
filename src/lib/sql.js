// A session with its resource name and seats left. Append a WHERE clause.
export const SCHEDULE_DETAIL_SQL = `
  SELECT s.id, s.resource_id, s.start_time, s.end_time, s.capacity, s.status,
         r.name AS resource_name,
         COALESCE(b.booked, 0)::int AS seats_booked,
         (s.capacity - COALESCE(b.booked, 0))::int AS seats_left,
         s.series_id
    FROM schedules s
    JOIN resources r ON r.id = s.resource_id AND r.tenant_id = s.tenant_id
    LEFT JOIN LATERAL (
      SELECT SUM(guests) AS booked
        FROM bookings
       WHERE schedule_id = s.id AND status <> 'cancelled'
    ) b ON true`;

// A booking with its session. Append a WHERE clause.
export const BOOKING_SQL = `
  SELECT b.id, b.schedule_id, s.resource_id, r.name AS resource_name,
         s.start_time, s.end_time, s.status AS schedule_status,
         b.user_id, b.guests, b.status, b.created_at, b.updated_at
    FROM bookings b
    JOIN schedules s ON s.id = b.schedule_id AND s.tenant_id = b.tenant_id
    JOIN resources r ON r.id = s.resource_id AND r.tenant_id = s.tenant_id`;