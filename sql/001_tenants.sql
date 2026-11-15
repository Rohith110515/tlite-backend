-- Needed in Phase 4 for the "no overlapping sessions" constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS tenants (
  slug           text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  signing_secret text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);