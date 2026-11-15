import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool, query } from '../db.js';

const BASE = `http://localhost:${config.port}/api`;
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`);
  }
}
const section = (title) => console.log(`\n${title}`);
const got = (r) => `got ${r.status} ${r.text.slice(0, 160)}`;

async function call(method, path, token, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

const tenants = [];
async function makeTenant(prefix) {
  const slug = `${prefix}-${crypto.randomBytes(3).toString('hex')}`;
  const secret = crypto.randomBytes(32).toString('hex');
  await query('INSERT INTO tenants (slug, name, signing_secret) VALUES ($1, $1, $2)', [slug, secret]);
  tenants.push(slug);
  return { slug, secret };
}
function mint(tenant, user = 'user_1', expiresIn = '10m') {
  const payload = { tenant_id: tenant.slug, ...(user ? { on_behalf_of: user } : {}) };
  return jwt.sign(payload, tenant.secret, { algorithm: 'HS256', audience: 'tarunam', expiresIn });
}

async function main() {
  const A = await makeTenant('smoke-a');
  const B = await makeTenant('smoke-b');
  const tokA = mint(A, 'user_42');
  const tokB = mint(B, 'user_7');

  /* ---------------- Service and auth ---------------- */
  section('Service and authentication');
  let r = await call('GET', '/health');
  check('health is 200 and connected', r.status === 200 && r.body?.db === 'connected', got(r));
  check('responses carry Cache-Control: no-store', r.headers.get('cache-control') === 'no-store');

  r = await call('GET', '/v1/resource-types');
  check('no token gives 401', r.status === 401, got(r));
  r = await call('GET', '/v1/resource-types', jwt.sign({ tenant_id: A.slug }, 'wrong-secret', { algorithm: 'HS256', audience: 'tarunam', expiresIn: '10m' }));
  check('token with wrong secret gives 401', r.status === 401, got(r));
  r = await call('GET', '/v1/resource-types', mint(A, 'u', '3h'));
  check('token living longer than 60 minutes gives 401', r.status === 401, got(r));
  r = await call('GET', '/v1/resource-types', jwt.sign({ tenant_id: 'no-such-tenant-xyz' }, 'x', { algorithm: 'HS256', audience: 'tarunam', expiresIn: '10m' }));
  check('token naming an unknown tenant gives 403', r.status === 403, got(r));

  const newSlug = `smoke-p-${crypto.randomBytes(3).toString('hex')}`;
  tenants.push(newSlug);
  const platformPost = (key) => call('POST', '/v1/platform/tenants', null, { slug: newSlug, name: 'Platform Test' }, { 'x-platform-key': key });
  r = await platformPost('wrong-key');
  check('wrong platform key gives 401', r.status === 401, got(r));
  r = await platformPost(config.platformKey);
  check('platform creates tenant (201 + secret)', r.status === 201 && !!r.body?.signing_secret, got(r));
  r = await platformPost(config.platformKey);
  check('repeat create returns 200 without secret', r.status === 200 && !r.body?.signing_secret, got(r));

  /* ---------------- Catalogue ---------------- */
  section('Resource types and resources');
  r = await call('POST', '/v1/resource-types', tokA, { name: 'Yoga Class', description: 'Group classes' });
  check('create resource type is 201', r.status === 201, got(r));
  const typeA = r.body?.id;
  r = await call('POST', '/v1/resource-types', tokA, { name: 'Yoga Class' });
  check('duplicate type name gives 409', r.status === 409, got(r));
  r = await call('POST', '/v1/resource-types', tokB, { name: 'Yoga Class' });
  check('another tenant may reuse the name', r.status === 201, got(r));
  r = await call('GET', '/v1/resource-types', tokA);
  check('list shows only my tenant (1 type)', r.status === 200 && r.body.length === 1, got(r));
  r = await call('POST', '/v1/resource-types', tokA, { name: '' });
  check('empty name gives 422', r.status === 422, got(r));
  r = await call('POST', '/v1/resource-types', tokA, { name: 'bad\u0000name' });
  check('NUL character gives 422', r.status === 422, got(r));
  r = await call('POST', '/v1/resource-types', tokA, { name: 'x'.repeat(70000) });
  check('body over 64 KiB gives 413', r.status === 413, got(r));

  async function makeResource(name, token = tokA, typeId = typeA) {
    const res = await call('POST', '/v1/resources', token, { resource_type_id: typeId, name });
    return res;
  }
  r = await makeResource('Studio 1');
  check('create resource is 201', r.status === 201, got(r));
  const R1 = r.body?.id;
  r = await makeResource('Studio 1');
  check('duplicate resource name gives 409', r.status === 409, got(r));
  r = await makeResource('Cross', tokB, typeA);
  check("using another tenant's type gives 404", r.status === 404, got(r));
  r = await call('POST', '/v1/resources', tokA, { resource_type_id: 'abc', name: 'Bad' });
  check('invalid uuid gives 422', r.status === 422, got(r));
  const R2 = (await makeResource('Studio 2 (rules)')).body?.id;
  const R3 = (await makeResource('Studio 3 (attendance)')).body?.id;
  const R6 = (await makeResource('Studio 6 (series)')).body?.id;
  r = await call('GET', '/v1/resources', tokA);
  check('list resources returns my 4', r.status === 200 && r.body.length === 4, got(r));

  /* ---------------- Schedules ---------------- */
  section('Schedules and the overlap constraint');
  const createSchedule = (resourceId, startMs, endMs, capacity = 1, token = tokA) =>
    call('POST', '/v1/schedules', token, { resource_id: resourceId, start_time: iso(startMs), end_time: iso(endMs), capacity });

  r = await createSchedule(R1, 2 * HOUR, 3 * HOUR, 5);
  check('create schedule is 201', r.status === 201, got(r));
  const S1 = r.body?.id;
  r = await createSchedule(R1, 2.5 * HOUR, 3.5 * HOUR);
  check('overlapping schedule gives 409', r.status === 409, got(r));
  r = await createSchedule(R1, 3 * HOUR, 4 * HOUR, 5);
  check('back-to-back schedule is allowed (201)', r.status === 201, got(r));
  const S2 = r.body?.id;
  r = await createSchedule(R1, 6 * HOUR, 5 * HOUR);
  check('end before start gives 400', r.status === 400, got(r));
  r = await call('POST', '/v1/schedules', tokA, { resource_id: R1, start_time: '2030-01-01T10:00:00', end_time: '2030-01-01T11:00:00' });
  check('timestamp without UTC offset gives 422', r.status === 422, got(r));
  r = await createSchedule(R1, 7 * HOUR, 8 * HOUR, 1, tokB);
  check("another tenant's resource gives 404", r.status === 404, got(r));

  const results = await Promise.all(Array.from({ length: 8 }, () => createSchedule(R1, 10 * HOUR, 11 * HOUR)));
  const ok201 = results.filter((x) => x.status === 201).length;
  const c409 = results.filter((x) => x.status === 409).length;
  check('8 simultaneous overlapping creates: exactly 1 wins', ok201 === 1 && c409 === 7, `${ok201} created, ${c409} conflicts`);

  r = await call('GET', `/v1/schedules/${S1}`, tokA);
  check('get schedule shows seats_left 5', r.status === 200 && r.body.seats_left === 5, got(r));
  r = await call('GET', '/v1/schedules', tokA);
  check('list sessions by date includes S1', r.status === 200 && r.body.some((s) => s.id === S1), got(r));
  r = await call('GET', `/v1/schedules?from=${encodeURIComponent(iso(0))}&to=${encodeURIComponent(iso(100 * DAY))}`, tokA);
  check('window over 93 days gives 400 invalid_time_window', r.status === 400 && r.body?.code === 'invalid_time_window', got(r));
  r = await call('GET', `/v1/resources/${R1}/schedules`, tokA);
  check("resource's open schedules list works", r.status === 200 && r.body.length >= 2 && r.body.every((s) => s.status === 'open'), got(r));

  /* ---------------- Booking ---------------- */
  section('Booking, capacity and idempotency');
  const book = (scheduleId, body, token = tokA) => call('POST', `/v1/schedules/${scheduleId}/book`, token, body);

  r = await book(S1, { user_id: 'user_42', guests: 2, idempotency_key: 'order-1' });
  check('book 2 guests is 201 confirmed', r.status === 201 && r.body?.status === 'confirmed', got(r));
  const bookingId = r.body?.booking_id;
  r = await book(S1, { user_id: 'user_42', guests: 2, idempotency_key: 'order-1' });
  check('replayed key returns the SAME booking', r.status === 201 && r.body?.booking_id === bookingId, got(r));
  r = await call('GET', `/v1/schedules/${S1}`, tokA);
  check('replay did not take extra seats (seats_left 3)', r.body?.seats_left === 3, got(r));
  r = await book(S2, { user_id: 'user_42', guests: 1, idempotency_key: 'order-1' });
  check('same key on another schedule gives 409 idempotency_key_reused', r.status === 409 && r.body?.code === 'idempotency_key_reused', got(r));
  r = await book(S1, { user_id: 'user_42', guests: 4 });
  check('too many guests gives 409 schedule_full', r.status === 409 && r.body?.code === 'schedule_full', got(r));
  r = await book(S1, { user_id: 'user_42', guests: 3 });
  check('booking the remaining 3 seats is 201', r.status === 201, got(r));
  const booking2 = r.body?.booking_id;
  r = await book(S2, { guests: 1 }, mint(A, null));
  check('no user_id and no on_behalf_of gives 400', r.status === 400, got(r));
  r = await book(S2, { guests: 1 });
  check('user falls back to on_behalf_of (user_42)', r.status === 201 && r.body?.user_id === 'user_42', got(r));

  section('Concurrency (the important part)');
  r = await createSchedule(R1, 20 * HOUR, 21 * HOUR, 5);
  const S3 = r.body?.id;
  const rush = await Promise.all(Array.from({ length: 20 }, (_, i) => book(S3, { user_id: `rush_${i}`, guests: 1 })));
  const won = rush.filter((x) => x.status === 201).length;
  const full = rush.filter((x) => x.status === 409 && x.body?.code === 'schedule_full').length;
  check('20 simultaneous bookings for 5 seats: exactly 5 succeed', won === 5 && full === 15, `${won} succeeded, ${full} refused as full`);
  r = await call('GET', `/v1/schedules/${S3}`, tokA);
  check('seats_left is exactly 0 (not oversold)', r.body?.seats_left === 0 && r.body?.seats_booked === 5, got(r));

  r = await createSchedule(R1, 22 * HOUR, 23 * HOUR, 10);
  const S4 = r.body?.id;
  const same = await Promise.all(Array.from({ length: 10 }, () => book(S4, { user_id: 'user_42', guests: 1, idempotency_key: 'race-key' })));
  const ids = new Set(same.map((x) => x.body?.booking_id));
  check('10 simultaneous requests with one key: one booking id', same.every((x) => x.status === 201) && ids.size === 1, `${ids.size} distinct ids`);
  r = await call('GET', `/v1/schedules/${S4}`, tokA);
  check('that key took only 1 seat', r.body?.seats_booked === 1, got(r));

  /* ---------------- Booking lifecycle ---------------- */
  section('Booking lifecycle');
  r = await call('GET', `/v1/bookings/${bookingId}`, tokA);
  check('get booking is 200', r.status === 200 && r.body?.id === bookingId, got(r));
  r = await call('GET', '/v1/bookings?user_id=user_42', tokA);
  check("list a user's bookings works", r.status === 200 && r.body.length >= 2, got(r));
  r = await call('POST', `/v1/bookings/${bookingId}/cancel`, tokA);
  check('cancel booking is 200 cancelled', r.status === 200 && r.body?.status === 'cancelled', got(r));
  r = await call('POST', `/v1/bookings/${bookingId}/cancel`, tokA);
  check('cancelling again returns it unchanged (200)', r.status === 200 && r.body?.status === 'cancelled', got(r));
  r = await call('GET', `/v1/schedules/${S1}`, tokA);
  check('cancelling gave the seats back (seats_left 2)', r.body?.seats_left === 2, got(r));
  r = await call('POST', `/v1/bookings/${bookingId}/check-in`, tokA);
  check('check-in on a cancelled booking gives 409 booking_cancelled', r.status === 409 && r.body?.code === 'booking_cancelled', got(r));
  r = await call('POST', `/v1/bookings/${booking2}/check-in`, tokA);
  check('check-in 2 hours early gives 409 attendance_not_open', r.status === 409 && r.body?.code === 'attendance_not_open', got(r));

  r = await createSchedule(R3, 30 * MIN, 90 * MIN, 3);
  const S8 = r.body?.id;
  r = await book(S8, { user_id: 'user_42', guests: 1 });
  const attendBooking = r.body?.booking_id;
  r = await call('POST', `/v1/bookings/${attendBooking}/check-in`, tokA);
  check('check-in inside the 60-minute window is 200 completed', r.status === 200 && r.body?.status === 'completed', got(r));
  r = await call('POST', `/v1/bookings/${attendBooking}/no-show`, tokA);
  check('no-show corrects a check-in (200 no_show)', r.status === 200 && r.body?.status === 'no_show', got(r));
  r = await call('POST', `/v1/bookings/${attendBooking}/cancel`, tokA);
  check('cancelling an attended booking gives 409 booking_not_cancellable', r.status === 409 && r.body?.code === 'booking_not_cancellable', got(r));

  section('Calling off a schedule');
  r = await createSchedule(R1, 24 * HOUR, 25 * HOUR, 3);
  const S5 = r.body?.id;
  await book(S5, { user_id: 'user_42', guests: 1 });
  r = await call('POST', `/v1/schedules/${S5}/cancel`, tokA);
  check('call off schedule cancels its bookings', r.status === 200 && r.body?.bookings_cancelled === 1, got(r));
  r = await call('POST', `/v1/schedules/${S5}/cancel`, tokA);
  check('calling off again changes nothing (0)', r.status === 200 && r.body?.bookings_cancelled === 0, got(r));
  r = await book(S5, { user_id: 'user_42', guests: 1 });
  check('booking a called-off session gives 409 schedule_not_open', r.status === 409 && r.body?.code === 'schedule_not_open', got(r));
  r = await createSchedule(R1, 24 * HOUR, 25 * HOUR, 3);
  check('the freed time range can be reused (201)', r.status === 201, got(r));

  /* ---------------- Rules and settings ---------------- */
  section('Rule sets and settings');
  r = await call('GET', `/v1/resources/${R1}/rules`, tokA);
  check('no rule set yet gives 404', r.status === 404, got(r));
  r = await call('POST', `/v1/resources/${R2}/rules`, tokA, { min_lead_minutes: 120, min_cancel_notice_minutes: 300 });
  check('store rule set is 201 with defaults filled', r.status === 201 && r.body?.max_horizon_minutes === 10080, got(r));
  r = await call('GET', `/v1/resources/${R2}/rules`, tokA);
  check('get rule set is 200', r.status === 200 && r.body?.min_lead_minutes === 120, got(r));

  r = await createSchedule(R2, 30 * MIN, 90 * MIN, 5);
  const T1 = r.body?.id;
  r = await book(T1, { user_id: 'user_42', guests: 1 });
  check('lead time rule gives 409 booking_closed', r.status === 409 && r.body?.code === 'booking_closed', got(r));
  r = await createSchedule(R2, 4 * HOUR, 5 * HOUR, 5);
  const T2 = r.body?.id;
  r = await book(T2, { user_id: 'user_42', guests: 1 });
  check('booking 4 hours ahead is allowed', r.status === 201, got(r));
  const ruleBooking = r.body?.booking_id;
  r = await call('POST', `/v1/bookings/${ruleBooking}/cancel`, tokA);
  check('cancel notice rule gives 409 cancellation_closed', r.status === 409 && r.body?.code === 'cancellation_closed', got(r));
  r = await createSchedule(R2, 8 * DAY, 8 * DAY + HOUR, 5);
  const T3 = r.body?.id;
  r = await book(T3, { user_id: 'user_42', guests: 1 });
  check('horizon rule gives 409 booking_not_open_yet', r.status === 409 && r.body?.code === 'booking_not_open_yet', got(r));

  r = await call('GET', '/v1/settings', tokA);
  check('settings default to all null', r.status === 200 && r.body?.min_lead_minutes === null, got(r));
  r = await call('PUT', '/v1/settings', tokA, { min_lead_minutes: 600 });
  check('PUT settings replaces all three', r.status === 200 && r.body?.min_lead_minutes === 600 && r.body?.max_horizon_minutes === null, got(r));
  r = await createSchedule(R1, 5 * HOUR, 6 * HOUR, 5);
  const S7 = r.body?.id;
  r = await book(S7, { user_id: 'user_42', guests: 1 });
  check('tenant settings apply to a resource without rules (booking_closed)', r.status === 409 && r.body?.code === 'booking_closed', got(r));
  r = await call('PUT', '/v1/settings', tokA, {});
  check('PUT {} clears every setting', r.status === 200 && r.body?.min_lead_minutes === null, got(r));
  r = await book(S7, { user_id: 'user_42', guests: 1 });
  check('booking works again after clearing settings', r.status === 201, got(r));

  /* ---------------- Series ---------------- */
  section('Series');
  const seriesBody = { resource_id: R6, weekdays: [1, 2, 3, 4, 5, 6, 7], start_times: ['06:30'], duration_minutes: 60, time_zone: 'Asia/Kolkata', capacity: 3 };
  r = await call('POST', '/v1/series', tokA, { ...seriesBody, time_zone: 'Mars/Phobos' });
  check('unknown time zone gives 422', r.status === 422, got(r));
  r = await call('POST', '/v1/series', tokA, seriesBody);
  check('create series makes about 8 weeks of sessions', r.status === 201 && r.body?.sessions_created >= 50, got(r));
  const seriesId = r.body?.id;
  const created = r.body?.sessions_created;
  r = await call('GET', `/v1/series?resource_id=${R6}`, tokA);
  check('list series shows it', r.status === 200 && r.body.length === 1, got(r));
  r = await call('GET', `/v1/schedules?resource_id=${R6}&to=${encodeURIComponent(iso(90 * DAY))}&limit=500`, tokA);
  check('generated sessions link back to the series', r.status === 200 && r.body.length >= 50 && r.body[0].series_id === seriesId, got(r));
  r = await call('POST', `/v1/series/${seriesId}/stop`, tokA, { cancel_future_sessions: true });
  check('stop series cancels all future sessions', r.status === 200 && r.body?.sessions_cancelled === created, got(r));
  r = await call('POST', `/v1/series/${crypto.randomUUID()}/stop`, tokA, {});
  check('stopping an unknown series gives 404 series_not_found', r.status === 404 && r.body?.code === 'series_not_found', got(r));

  /* ---------------- Tenant isolation ---------------- */
  section('Tenant isolation');
  r = await call('GET', `/v1/schedules/${S1}`, tokB);
  check("tenant B cannot read tenant A's schedule (404)", r.status === 404 && r.body?.code === 'schedule_not_found', got(r));
  r = await call('GET', `/v1/bookings/${booking2}`, tokB);
  check("tenant B cannot read tenant A's booking (404)", r.status === 404 && r.body?.code === 'booking_not_found', got(r));
  r = await book(S1, { user_id: 'x', guests: 1 }, tokB);
  check("tenant B cannot book tenant A's schedule (404)", r.status === 404, got(r));
  r = await call('GET', '/v1/resources', tokB);
  check('tenant B sees none of tenant A resources', r.status === 200 && r.body.length === 0, got(r));
}

try {
  await main();
} catch (err) {
  failed++;
  console.log('\n  CRASH', err.message);
}

try {
  await query('DELETE FROM tenants WHERE slug = ANY($1)', [tenants]);
} catch (err) {
  console.log('\ncleanup failed:', err.message);
}
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);