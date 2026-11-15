CREATE TABLE IF NOT EXISTS resource_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),   -- names are unique within a tenant
  UNIQUE (tenant_id, id)      -- lets resources point at (tenant, id) together
);

CREATE TABLE IF NOT EXISTS resources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL,
  resource_type_id uuid NOT NULL,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  is_exclusive     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),   -- unique across ALL types within a tenant
  UNIQUE (tenant_id, id),
  -- Composite foreign key: a resource can only point at a type of the SAME tenant.
  -- Even a bug in the code cannot link tenant A's resource to tenant B's type.
  FOREIGN KEY (tenant_id, resource_type_id)
    REFERENCES resource_types (tenant_id, id) ON DELETE CASCADE
);