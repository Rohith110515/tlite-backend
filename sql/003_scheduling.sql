-- Tenant-wide defaults (a field left NULL is not enforced)
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id                 text PRIMARY KEY REFERENCES tenants(slug) ON DELETE CASCADE,
  min_lead_minutes          int CHECK (min_lead_minutes BETWEEN 0 AND 5256000),
  max_horizon_minutes       int CHECK (max_horizon_minutes BETWEEN 1 AND 5256000),
  min_cancel_notice_minutes int CHECK (min_cancel_notice_minutes BETWEEN 0 AND 5256000)
);

-- Per-resource rule set (at most one per resource)
CREATE TABLE IF NOT EXISTS resource_rules (
  resource_id               uuid PRIMARY KEY,
  tenant_id                 text NOT NULL,
  min_lead_minutes          int NOT NULL DEFAULT 0     CHECK (min_lead_minutes BETWEEN 0 AND 5256000),
  max_horizon_minutes       int NOT NULL DEFAULT 10080 CHECK (max_horizon_minutes BETWEEN 1 AND 5256000),
  max_duration_minutes      int NOT NULL DEFAULT 1440  CHECK (max_duration_minutes BETWEEN 1 AND 5256000),
  max_capacity              int NOT NULL DEFAULT 1     CHECK (max_capacity BETWEEN 1 AND 100000),
  min_cancel_notice_minutes int NOT NULL DEFAULT 0     CHECK (min_cancel_notice_minutes BETWEEN 0 AND 5256000),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id) ON DELETE CASCADE
);

-- Weekly timetables that generate schedules
CREATE TABLE IF NOT EXISTS series (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text NOT NULL,
  resource_id       uuid NOT NULL,
  weekdays          int[] NOT NULL,
  start_times       text[] NOT NULL,
  duration_minutes  int NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  capacity          int NOT NULL CHECK (capacity BETWEEN 1 AND 100000),
  time_zone         text NOT NULL,
  starts_on         date NOT NULL,
  ends_on           date,
  generated_through date NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id) ON DELETE CASCADE
);

-- One bookable session
CREATE TABLE IF NOT EXISTS schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  resource_id uuid NOT NULL,
  series_id   uuid REFERENCES series(id) ON DELETE SET NULL,
  start_time  timestamptz NOT NULL,
  end_time    timestamptz NOT NULL,
  capacity    int NOT NULL CHECK (capacity BETWEEN 1 AND 100000),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id) ON DELETE CASCADE,
  -- THE overlap guarantee: two OPEN sessions of one resource can never overlap.
  -- Ranges are [start, end), so back-to-back sessions are allowed,
  -- and cancelled sessions are excluded, which frees their time slot.
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_time, end_time) WITH &&
  ) WHERE (status = 'open')
);
CREATE INDEX IF NOT EXISTS schedules_tenant_start ON schedules (tenant_id, start_time);
CREATE INDEX IF NOT EXISTS schedules_series ON schedules (series_id);

CREATE TABLE IF NOT EXISTS bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  schedule_id     uuid NOT NULL,
  user_id         text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 255),
  guests          int NOT NULL CHECK (guests BETWEEN 1 AND 100000),
  status          text NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 255),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Idempotency: a key is unique per tenant (many NULL keys are allowed)
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES schedules (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bookings_user ON bookings (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS bookings_schedule ON bookings (schedule_id);