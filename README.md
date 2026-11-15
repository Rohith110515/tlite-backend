tarunam-lite

A multi-tenant booking API built with Node.js, Express and PostgreSQL. It is a learning replica of the Tarunam headless booking REST API and implements all 26 operations of its public API reference.

A tenant (for example a yoga studio) defines bookable resources, publishes time slots, and books seats for its end users. The API guarantees that sessions never overlap, seats are never oversold, and retried requests never create duplicate bookings.

Status: educational project. It is not production-hardened (see Security notes).

Features
Multi-tenant JWT authentication. Each tenant has its own HS256 signing secret.
Tenant isolation. Every query is scoped to the tenant in the verified token, and foreign keys stop cross-tenant links.
No overlapping sessions. A PostgreSQL exclusion constraint rejects overlaps, even from simultaneous requests.
No overselling. Booking runs in one transaction under a row lock.
Idempotent booking. A repeated idempotency_key returns the original booking.
Booking rules. Lead time, booking window and cancellation notice, set per resource or for the whole tenant.
Weekly series. A timetable generates sessions about eight weeks ahead and tops itself up hourly.
Interactive docs. Swagger UI for all 26 operations.
Automated tests. An 80-check smoke suite, including concurrent booking tests.
Tech stack
Part	Choice
Runtime	Node.js (ES modules)
Framework	Express 5
Database	PostgreSQL
Auth	jsonwebtoken (HS256)
Validation	zod
Time zones	luxon
Docs	swagger-ui-express
Prerequisites
Node.js 20 or newer (developed on Node 24)
PostgreSQL 13 or newer (developed on 18). The btree_gist extension must be available. It ships with the standard PostgreSQL installers.
Setup
1. Get the code and install packages
bash
git clone https://github.com/Rohith110515/tlite-backend.git
cd tlite-backend
npm install
2. Create the database

In pgAdmin (Databases, Create, Database), or with psql:

sql
CREATE DATABASE "tarunam-lite";

The name must match the one in DATABASE_URL below.

3. Create the .env file

Create a file named .env in the project root:

PORT=3000
DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/tarunam-lite
PLATFORM_KEY=a-long-random-string
Variable	Meaning
PORT	Port the API listens on
DATABASE_URL	PostgreSQL connection string. Special characters in the password must be URL-encoded (@ becomes %40, # becomes %23).
PLATFORM_KEY	Shared key that authorizes tenant creation, sent in the x-platform-key header

Generate a good PLATFORM_KEY with:

bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"

Never commit .env. It is already listed in .gitignore.

4. Create the tables and start the server
bash
npm run migrate
npm run dev

You should see migrations done, then tarunam-lite listening on http://localhost:3000.

Open http://localhost:3000/api-docs for the Swagger UI, or http://localhost:3000/api/health, which should report "db": "connected".

Scripts
Command	What it does
npm run dev	Start the server and restart on file changes
npm start	Start the server
npm run migrate	Run every file in sql/ in order (safe to re-run)
npm run token -- <tenant> [user] [minutes]	Print a tenant JWT for development
npm run smoke	Run the end-to-end test suite (the server must be running)
Quick start: first booking

The easiest way is the Swagger UI at /api-docs. Click Authorize to enter the platform key and a tenant token, then follow these steps.

1. Create a tenant (POST /api/v1/platform/tenants, platform key):

bash
curl -X POST http://localhost:3000/api/v1/platform/tenants \
  -H "x-platform-key: YOUR_PLATFORM_KEY" \
  -H "Content-Type: application/json" \
  -d '{"slug":"demo-studio","name":"Demo Studio"}'

The response includes a signing_secret. It is shown once.

2. Mint a token. In real use the tenant's own server signs this. For development:

bash
npm run token -- demo-studio user_42

Use the output as Authorization: Bearer <token>. Tokens last 30 minutes by default. Replace the token when you get a 401.

3. Set up the catalogue and a session (all with the bearer token):

POST /api/v1/resource-types with {"name":"Yoga Class"}
POST /api/v1/resources with the type id and {"name":"Studio A"}
POST /api/v1/schedules with the resource id, a future start_time and end_time (ISO 8601 with a UTC offset, for example 2030-01-01T10:00:00+05:30), and a capacity

4. Book it:

bash
curl -X POST http://localhost:3000/api/v1/schedules/<schedule_id>/book \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user_42","guests":2,"idempotency_key":"order-1042"}'

Send the same request again: you get the same booking_id and no second booking.

Authentication

Two kinds of credentials are used:

Credential	Used for	Sent as
Platform key	Creating and listing tenants	x-platform-key header
Tenant JWT	Everything under /api/v1 except the platform routes	Authorization: Bearer <token>

A tenant JWT must be:

signed with HS256 using that tenant's signing secret
carry aud = tarunam, tenant_id = the tenant slug, and exp at most 60 minutes ahead
optionally carry on_behalf_of (the end user's id, used when a booking has no user_id)

A clock tolerance of 30 seconds is applied. A token naming an unknown tenant gets 403. Any other problem gets 401.

API overview

All paths are under /api. Interactive documentation is at /api-docs.

Group	Operations
Service	GET /health
Platform	POST /v1/platform/tenants, GET /v1/platform/tenants
Resource types	GET, POST /v1/resource-types
Resources	GET, POST /v1/resources
Rule sets	POST, GET /v1/resources/{resource_id}/rules
Schedules	POST, GET /v1/schedules · GET /v1/schedules/{id} · GET /v1/resources/{id}/schedules · GET /v1/schedules/{id}/bookings · POST /v1/schedules/{id}/cancel · POST /v1/schedules/{id}/book
Series	POST, GET /v1/series · POST /v1/series/{id}/stop
Bookings	GET /v1/bookings · GET /v1/bookings/{id} · POST /v1/bookings/{id}/cancel · POST /v1/bookings/{id}/check-in · POST /v1/bookings/{id}/no-show
Booking settings	GET, PUT /v1/settings
Data model
Tenant
 ├─ Settings (default lead time, booking window, cancel notice)
 ├─ Resource type ("Yoga Class")
 │    └─ Resource ("Studio A") ── optional Rule set
 │         └─ Schedule = one session (start, end, capacity)
 │              └─ Booking = a user + number of guests
 └─ Series = weekly timetable that generates schedules
State machines
Schedule:  open ──cancel──▶ cancelled

Booking:   confirmed ──cancel──▶ cancelled
              ├──check-in──▶ completed ◀──┐  (the two attendance states
              └──no-show───▶ no_show   ───┘   can correct each other)

Seats stay taken by confirmed, completed and no_show bookings. Only cancelled bookings give seats back.

Error format
Status	Body
400, 401, 403, 404, 409, 413	{ "detail": "..." }, with a code where the code is documented
422	{ "detail": [ { "type", "loc", "msg", "input" } ] }
500	Plain text Internal Server Error

Machine-readable code values: schedule_not_found, booking_not_found, series_not_found, schedule_full, schedule_not_open, schedule_started, schedule_ended, booking_closed, booking_not_open_yet, idempotency_key_reused, booking_not_cancellable, cancellation_closed, booking_cancelled, attendance_not_open, invalid_time_window.

How the guarantees are enforced
Guarantee	Mechanism	Location
Tenant verified before trusted	The token is read unverified only to choose the tenant's secret, then fully verified with that secret. The algorithm is pinned to HS256.	src/auth.js
Tenant isolation	tenant_id comes only from the verified token. Every query filters by it, and other tenants' objects return 404.	all routes
Cross-tenant links impossible	Composite foreign keys on (tenant_id, id)	sql/002, sql/003
No overlapping sessions	EXCLUDE USING gist on (resource_id, tstzrange(start, end)) for open sessions. Ranges are half-open, so back-to-back sessions are allowed.	sql/003_scheduling.sql
No overselling	SELECT ... FOR UPDATE on the schedule row, then count seats, then insert, in one transaction	src/routes/schedules.js
Safe retries	UNIQUE (tenant_id, idempotency_key), plus a replay check after taking the lock	sql/003, src/routes/schedules.js
Rule precedence	A resource's own rule set wins, otherwise tenant settings apply. NULL means "not enforced".	src/lib/rules.js

The booking checks run in this order: schedule exists for the tenant, idempotency replay, schedule open, not started, lead time, booking window, seats left, insert.

Project structure
tarunam-lite/
├── sql/                    migrations, run in filename order
│   ├── 001_tenants.sql
│   ├── 002_catalogue.sql
│   └── 003_scheduling.sql
├── src/
│   ├── server.js           starts the server and the series top-up job
│   ├── app.js              middleware and route mounting
│   ├── config.js           environment variables
│   ├── db.js               connection pool and transaction helper
│   ├── auth.js             tenant JWT verification
│   ├── errors.js           error types, validation helpers, error handler
│   ├── swagger.js          OpenAPI document and Swagger UI
│   ├── routes/             health, platform, catalogue, rules, schedules, bookings, series, v1
│   ├── lib/                rules (rule precedence), series (generator), sql (shared queries)
│   └── scripts/            migrate, mint-token, smoke
└── .env                    local settings (never committed)
Testing

Start the server in one terminal, then in another:

bash
npm run smoke

The script creates its own throwaway tenants, runs 80 checks across every endpoint group, and deletes its data afterwards. It includes the concurrency tests:

8 simultaneous overlapping session creations: exactly 1 succeeds
20 simultaneous bookings for 5 seats: exactly 5 succeed, and the session ends with 0 seats left
10 simultaneous requests with the same idempotency key: one booking and one seat taken

The target output is 80 passed, 0 failed.

Differences from the real Tarunam
Real Tarunam	This project
The Tarunam team provisions tenants and secrets	A platform key creates tenants
Internal design unknown	The schema and locking approach are a reconstruction from the documented behaviour
Likely a scheduled job for series top-up	Runs inside the server at startup and every hour
Production hardening	None (see below)
Paths with a trailing slash answer 404	Not replicated

The reference being replicated is the public Tarunam API reference and its OpenAPI document at https://tarunam.moonproduct.tech/openapi.json.

Security notes

This is a learning project. Before any real use you would need to add:

HTTPS, and rate limiting on all routes
encryption at rest for tenant signing secrets (HS256 needs the secret itself, so it cannot simply be hashed)
request logging and audit trails
a safer provisioning flow in place of the shared platform key
a review of the 403 versus 401 responses, which reveal whether a tenant slug exists (the real API reference documents the same behaviour)

Never commit .env, and never paste signing secrets or the platform key into screenshots or chat.

Troubleshooting
Problem	Fix
database "..." does not exist	Create the database. Its name must match DATABASE_URL exactly, and hyphen and underscore are different names.
password authentication failed	The password in DATABASE_URL is wrong, or has special characters that need URL-encoding.
ECONNREFUSED	PostgreSQL is not running. Start the service.
permission denied to create extension "btree_gist"	Run the migration as a superuser such as postgres.
ERR_MODULE_NOT_FOUND	A file is missing or in the wrong folder. The error names the file.
401 on every request	The token expired (30 minutes) or was signed with a different secret. Mint a new one.
Cannot find package	Run npm install.
Port already in use	Change PORT in .env.
License

Educational project, no license specified.