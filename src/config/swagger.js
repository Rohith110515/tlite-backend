import swaggerUi from 'swagger-ui-express';

/* ---------- small helpers to keep the spec readable ---------- */
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const param = (name) => ({ $ref: `#/components/parameters/${name}` });
const errRef = (code) => ({ $ref: `#/components/responses/${code}` });
const arrayOf = (name) => ({ type: 'array', items: ref(name) });
const json = (schema, example) => ({ 'application/json': { schema, ...(example ? { example } : {}) } });
const ok = (description, schema) => ({ description, ...(schema ? { content: json(schema) } : {}) });
const requestBody = (schema, example) => ({ required: true, content: json(schema, example) });

const str = (extra = {}) => ({ type: 'string', ...extra });
const int = (extra = {}) => ({ type: 'integer', ...extra });
const uuid = () => str({ format: 'uuid' });
const time = () => str({ format: 'date-time' });
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });

const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Tarunam Clone API',
    version: '1.0.0',
    description:
      'Local replica of the Tarunam headless booking REST API.\n\n' +
      '**Typical flow:** create a tenant, mint a token (`npm run token -- <slug> <user>`), ' +
      'create a resource type, a resource and a schedule (or a series), then book the schedule.',
  },
  servers: [{ url: 'http://localhost:3000', description: 'Local development server' }],

  // Every operation needs a tenant JWT unless it overrides this
  security: [{ bearerAuth: [] }],

  tags: [
    { name: 'Service' },
    { name: 'Platform' },
    { name: 'Resource types' },
    { name: 'Resources' },
    { name: 'Rule sets' },
    { name: 'Schedules' },
    { name: 'Series' },
    { name: 'Bookings' },
    { name: 'Booking settings' },
  ],

  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Tenant JWT (HS256, aud "tarunam", exp at most 60 min ahead, tenant_id claim). ' +
          'Mint one with: npm run token -- <tenant-slug> [user-id]',
      },
      PlatformKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-platform-key',
        description: 'Platform management key from your .env file',
      },
    },

    parameters: {
      ScheduleId: { name: 'schedule_id', in: 'path', required: true, schema: uuid(), description: 'Id of a schedule owned by your tenant.' },
      ResourceId: { name: 'resource_id', in: 'path', required: true, schema: uuid(), description: 'Id of a resource owned by your tenant.' },
      BookingId: { name: 'booking_id', in: 'path', required: true, schema: uuid(), description: 'Id of a booking owned by your tenant.' },
      SeriesId: { name: 'series_id', in: 'path', required: true, schema: uuid(), description: 'Id of a series owned by your tenant.' },
    },

    responses: {
      E400: { description: 'Bad request. Codes: invalid_time_window.', content: json(ref('Error')) },
      E401: { description: 'Bearer token missing, malformed, expired, too long-lived, or wrongly signed.', content: json(ref('Error')) },
      E403: { description: 'The token names a tenant that does not exist.', content: json(ref('Error')) },
      E404: { description: 'Not found for your tenant. Codes: schedule_not_found, booking_not_found, series_not_found.', content: json(ref('Error')) },
      E409: { description: 'Conflict. See the code field.', content: json(ref('Error')) },
      E413: { description: 'Request body larger than 64 KiB.', content: json(ref('Error')) },
      E422: { description: 'Request failed validation.', content: json(ref('ValidationError')) },
    },

    schemas: {
      Error: obj({ detail: str(), code: str({ description: 'Fixed identifier your code can act on, such as schedule_full.' }) }, ['detail']),
      ValidationError: obj({
        detail: {
          type: 'array',
          items: obj({
            type: str(),
            loc: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'integer' }] } },
            msg: str(),
            input: {},
          }),
        },
      }),
      Health: obj({ status: str({ example: 'ok' }), service: str({ example: 'tarunam-lite' }), db: str({ example: 'connected' }) }),

      Tenant: obj({ slug: str(), name: str(), created_at: time() }),
      TenantCreated: obj({ slug: str(), name: str(), created_at: time(), signing_secret: str({ description: 'Shown once, on creation only.' }) }),
      TenantInput: obj({ slug: str({ pattern: '^[a-z0-9][a-z0-9-]{0,62}$', example: 'demo-studio' }), name: str({ minLength: 1, maxLength: 200, example: 'Demo Studio' }) }, ['slug', 'name']),

      ResourceType: obj({ id: uuid(), name: str(), description: str({ nullable: true }), created_at: time() }),
      ResourceTypeInput: obj({ name: str({ minLength: 1, maxLength: 200, example: 'Yoga Class' }), description: str({ maxLength: 2000, nullable: true, example: 'Group classes for all levels.' }) }, ['name']),

      Resource: obj({ id: uuid(), resource_type_id: uuid(), name: str(), is_exclusive: { type: 'boolean' }, created_at: time() }),
      ResourceInput: obj({ resource_type_id: uuid(), name: str({ minLength: 1, maxLength: 200, example: 'Studio A' }), is_exclusive: { type: 'boolean', default: false } }, ['resource_type_id', 'name']),

      ResourceRules: obj({
        resource_id: uuid(),
        min_lead_minutes: int(),
        max_horizon_minutes: int(),
        max_duration_minutes: int({ description: 'Stored only, not enforced.' }),
        max_capacity: int({ description: 'Stored only, not enforced.' }),
        min_cancel_notice_minutes: int(),
      }),
      RulesInput: obj({
        min_lead_minutes: int({ minimum: 0, maximum: 5256000, default: 0 }),
        max_horizon_minutes: int({ minimum: 1, maximum: 5256000, default: 10080 }),
        max_duration_minutes: int({ minimum: 1, maximum: 5256000, default: 1440 }),
        max_capacity: int({ minimum: 1, maximum: 100000, default: 1 }),
        min_cancel_notice_minutes: int({ minimum: 0, maximum: 5256000, default: 0 }),
      }),

      Settings: obj({
        min_lead_minutes: int({ nullable: true }),
        max_horizon_minutes: int({ nullable: true }),
        min_cancel_notice_minutes: int({ nullable: true }),
      }),

      Schedule: obj({ id: uuid(), resource_id: uuid(), start_time: time(), end_time: time(), capacity: int(), status: str({ enum: ['open', 'cancelled'] }) }),
      ScheduleInput: obj({
        resource_id: uuid(),
        start_time: time(),
        end_time: time(),
        capacity: int({ minimum: 1, maximum: 100000, default: 1 }),
      }, ['resource_id', 'start_time', 'end_time']),
      ScheduleDetail: obj({
        id: uuid(), resource_id: uuid(), start_time: time(), end_time: time(), capacity: int(),
        status: str({ enum: ['open', 'cancelled'] }),
        resource_name: str(),
        seats_booked: int(),
        seats_left: int(),
        series_id: uuid(),
      }),
      ScheduleCancelled: obj({ schedule_id: uuid(), status: str({ example: 'cancelled' }), bookings_cancelled: int() }),

      BookInput: obj({
        user_id: str({ minLength: 1, maxLength: 255, nullable: true, description: 'Defaults to the token on_behalf_of claim.' }),
        guests: int({ minimum: 1, maximum: 100000, default: 1 }),
        idempotency_key: str({ minLength: 1, maxLength: 255, nullable: true, description: 'A repeated key returns the original booking.' }),
      }),
      BookingCreated: obj({ booking_id: uuid(), schedule_id: uuid(), user_id: str(), guests: int(), status: str({ enum: ['confirmed', 'cancelled', 'completed', 'no_show'] }) }),
      Booking: obj({
        id: uuid(), schedule_id: uuid(), resource_id: uuid(), resource_name: str(),
        start_time: time(), end_time: time(), schedule_status: str(),
        user_id: str(), guests: int(),
        status: str({ enum: ['confirmed', 'cancelled', 'completed', 'no_show'] }),
        created_at: time(), updated_at: time(),
      }),

      Series: obj({
        id: uuid(), resource_id: uuid(),
        weekdays: { type: 'array', items: int() },
        start_times: { type: 'array', items: str() },
        duration_minutes: int(), capacity: int(), time_zone: str(),
        starts_on: str({ format: 'date' }),
        ends_on: str({ format: 'date', nullable: true }),
        generated_through: str({ format: 'date' }),
        status: str({ enum: ['active', 'stopped'] }),
      }),
      SeriesCreated: obj({
        id: uuid(), resource_id: uuid(),
        weekdays: { type: 'array', items: int() },
        start_times: { type: 'array', items: str() },
        duration_minutes: int(), capacity: int(), time_zone: str(),
        starts_on: str({ format: 'date' }),
        ends_on: str({ format: 'date', nullable: true }),
        generated_through: str({ format: 'date' }),
        status: str(),
        sessions_created: int(),
      }),
      SeriesInput: obj({
        resource_id: uuid(),
        weekdays: { type: 'array', minItems: 1, maxItems: 7, items: int({ minimum: 1, maximum: 7 }), description: '1 is Monday, 7 is Sunday.' },
        start_times: { type: 'array', minItems: 1, maxItems: 96, items: str({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }), description: 'Local start times, HH:MM.' },
        duration_minutes: int({ minimum: 1, maximum: 1440 }),
        time_zone: str({ example: 'Asia/Kolkata' }),
        capacity: int({ minimum: 1, maximum: 100000, default: 1 }),
        starts_on: str({ format: 'date', nullable: true }),
        ends_on: str({ format: 'date', nullable: true }),
      }, ['resource_id', 'weekdays', 'start_times', 'duration_minutes', 'time_zone']),
      StopSeriesInput: obj({ cancel_future_sessions: { type: 'boolean', default: false } }),
      SeriesStopped: obj({ series_id: uuid(), status: str({ example: 'stopped' }), sessions_cancelled: int(), bookings_cancelled: int() }),
    },
  },

  paths: {
    /* ---------------- Service ---------------- */
    '/api/health': {
      get: {
        tags: ['Service'],
        summary: 'Service health check',
        security: [],
        responses: {
          200: ok('Service is healthy and the database is connected', ref('Health')),
          503: ok('Database unreachable', ref('Health')),
        },
      },
    },

    /* ---------------- Platform ---------------- */
    '/api/v1/platform/tenants': {
      post: {
        tags: ['Platform'],
        summary: 'Create a tenant',
        description: 'Calling it again with an existing slug returns the tenant without its secret, so a retry is safe.',
        security: [{ PlatformKeyAuth: [] }],
        requestBody: requestBody(ref('TenantInput')),
        responses: {
          200: ok('Tenant already exists', ref('Tenant')),
          201: ok('Tenant created. The signing secret is shown only now.', ref('TenantCreated')),
          401: { description: 'Invalid platform key', content: json(ref('Error')) },
          413: errRef('E413'),
          422: errRef('E422'),
        },
      },
      get: {
        tags: ['Platform'],
        summary: 'List all tenants',
        security: [{ PlatformKeyAuth: [] }],
        responses: {
          200: ok('Every tenant, oldest first', arrayOf('Tenant')),
          401: { description: 'Invalid platform key', content: json(ref('Error')) },
        },
      },
    },

    /* ---------------- Resource types ---------------- */
    '/api/v1/resource-types': {
      get: {
        tags: ['Resource types'],
        summary: 'List resource types',
        responses: { 200: ok('Your resource types, ordered by name', arrayOf('ResourceType')), 401: errRef('E401'), 403: errRef('E403') },
      },
      post: {
        tags: ['Resource types'],
        summary: 'Create a resource type',
        description: 'A category of bookable thing, such as Yoga Class. Names are unique within your tenant.',
        requestBody: requestBody(ref('ResourceTypeInput')),
        responses: {
          201: ok('The resource type that was created', ref('ResourceType')),
          401: errRef('E401'), 403: errRef('E403'), 409: errRef('E409'), 413: errRef('E413'), 422: errRef('E422'),
        },
      },
    },

    /* ---------------- Resources ---------------- */
    '/api/v1/resources': {
      get: {
        tags: ['Resources'],
        summary: 'List resources',
        responses: { 200: ok('Your resources, ordered by name', arrayOf('Resource')), 401: errRef('E401'), 403: errRef('E403') },
      },
      post: {
        tags: ['Resources'],
        summary: 'Create a resource',
        description: 'The thing that gets booked: a class, a trainer, a room. Names are unique across all resource types in your tenant.',
        requestBody: requestBody(ref('ResourceInput')),
        responses: {
          201: ok('The resource that was created', ref('Resource')),
          401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'), 409: errRef('E409'), 413: errRef('E413'), 422: errRef('E422'),
        },
      },
    },

    /* ---------------- Rule sets ---------------- */
    '/api/v1/resources/{resource_id}/rules': {
      parameters: [param('ResourceId')],
      post: {
        tags: ['Rule sets'],
        summary: 'Store the rule set of a resource',
        description: 'Each resource has at most one rule set; calling again replaces it. A field you leave out returns to its default.',
        requestBody: requestBody(ref('RulesInput'), { min_lead_minutes: 60, max_horizon_minutes: 10080, max_duration_minutes: 90, max_capacity: 12, min_cancel_notice_minutes: 30 }),
        responses: {
          201: ok('The rule set now stored', ref('ResourceRules')),
          401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'), 413: errRef('E413'), 422: errRef('E422'),
        },
      },
      get: {
        tags: ['Rule sets'],
        summary: 'Get the rule set of a resource',
        responses: { 200: ok('The stored rule set', ref('ResourceRules')), 401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'), 422: errRef('E422') },
      },
    },

    /* ---------------- Schedules ---------------- */
    '/api/v1/schedules': {
      post: {
        tags: ['Schedules'],
        summary: 'Create a schedule',
        description:
          'One bookable session. A resource cannot have two overlapping sessions: the database rejects the second one ' +
          '(409), so concurrent requests cannot both succeed. Back-to-back sessions are allowed and a cancelled session does not count.',
        requestBody: requestBody(ref('ScheduleInput'), { resource_id: '<resource id>', start_time: '2030-01-01T10:00:00+05:30', end_time: '2030-01-01T11:00:00+05:30', capacity: 12 }),
        responses: {
          201: ok('The schedule that was created', ref('Schedule')),
          400: errRef('E400'), 401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'), 409: errRef('E409'), 413: errRef('E413'), 422: errRef('E422'),
        },
      },
      get: {
        tags: ['Schedules'],
        summary: 'List sessions by date',
        description: 'Sessions that start in a window, earliest first, with seats left.',
        parameters: [
          { name: 'from', in: 'query', schema: time(), description: 'Defaults to now.' },
          { name: 'to', in: 'query', schema: time(), description: 'Defaults to 14 days after from. At most 93 days after from.' },
          { name: 'resource_id', in: 'query', schema: uuid() },
          { name: 'include_cancelled', in: 'query', schema: { type: 'boolean', default: false } },
          { name: 'limit', in: 'query', schema: int({ minimum: 1, maximum: 500, default: 200 }) },
        ],
        responses: { 200: ok('Sessions with seats left', arrayOf('ScheduleDetail')), 400: errRef('E400'), 401: errRef('E401'), 403: errRef('E403'), 422: errRef('E422') },
      },
    },
    '/api/v1/schedules/{schedule_id}': {
      parameters: [param('ScheduleId')],
      get: {
        tags: ['Schedules'],
        summary: 'Get a schedule',
        responses: { 200: ok('The schedule, in any status, with seats left', ref('ScheduleDetail')), 401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'), 422: errRef('E422') },
      },
    },
    '/api/v1/resources/{resource_id}/schedules': {
      parameters: [param('ResourceId')],
      get: {
        tags: ['Schedules'],
        summary: 'List the open schedules of a resource',
        description: 'Every open session, earliest first, past ones included. Empty list when there are none, or when the resource belongs to another tenant.',
        responses: { 200: ok('Open schedules', arrayOf('Schedule')), 401: errRef('E401'), 403: errRef('E403'), 422: errRef('E422') },
      },
    },
    '/api/v1/schedules/{schedule_id}/bookings': {
      parameters: [param('ScheduleId')],
      get: {
        tags: ['Schedules'],
        summary: 'List the bookings of a schedule',
        description: 'Everyone booked on one session, for a roster or attendance list.',
        responses: { 200: ok('Bookings in any status, in the order they were made', arrayOf('Booking')), 401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'), 422: errRef('E422') },
      },
    },
    '/api/v1/schedules/{schedule_id}/cancel': {
      parameters: [param('ScheduleId')],
      post: {
        tags: ['Schedules'],
        summary: 'Call off a schedule',
        description: 'Takes no more bookings and cancels every confirmed booking on it. Allowed until the session ends. Repeating it changes nothing.',
        responses: {
          200: ok('The schedule, now cancelled', ref('ScheduleCancelled')),
          401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'),
          409: { description: 'The session has ended (schedule_ended).', content: json(ref('Error')) },
          422: errRef('E422'),
        },
      },
    },
    '/api/v1/schedules/{schedule_id}/book': {
      parameters: [param('ScheduleId')],
      post: {
        tags: ['Schedules'],
        summary: 'Book a schedule',
        description:
          'Reserves guests on a session for one user. The checks and the insert run in one transaction under a row lock, ' +
          'so two requests for the last seat cannot both succeed.\n\n' +
          '**Idempotency:** a repeated idempotency_key returns the original booking unchanged. Keys are unique per tenant. ' +
          'A key keeps its booking after it is cancelled, so use a new key to book again.\n\n' +
          '**409 codes:** schedule_full, schedule_not_open, schedule_started, booking_closed, booking_not_open_yet, idempotency_key_reused.',
        requestBody: requestBody(ref('BookInput'), { user_id: 'user_42', guests: 2, idempotency_key: 'order-1042' }),
        responses: {
          201: ok('The booking as stored', ref('BookingCreated')),
          400: errRef('E400'), 401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'), 409: errRef('E409'), 413: errRef('E413'), 422: errRef('E422'),
        },
      },
    },

    /* ---------------- Series ---------------- */
    '/api/v1/series': {
      post: {
        tags: ['Series'],
        summary: 'Create a series',
        description: 'A weekly timetable for one resource. Sessions are created about eight weeks ahead and topped up over time. A session that would overlap an existing one is skipped.',
        requestBody: requestBody(ref('SeriesInput'), { resource_id: '<resource id>', weekdays: [1, 3], start_times: ['06:30', '18:00'], duration_minutes: 60, time_zone: 'Asia/Kolkata', capacity: 12 }),
        responses: { 201: ok('The series and how many sessions it created', ref('SeriesCreated')), 401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'), 413: errRef('E413'), 422: errRef('E422') },
      },
      get: {
        tags: ['Series'],
        summary: 'List series',
        parameters: [{ name: 'resource_id', in: 'query', schema: uuid() }],
        responses: { 200: ok('Your series, newest first', arrayOf('Series')), 401: errRef('E401'), 403: errRef('E403'), 422: errRef('E422') },
      },
    },
    '/api/v1/series/{series_id}/stop': {
      parameters: [param('SeriesId')],
      post: {
        tags: ['Series'],
        summary: 'Stop a series',
        description: 'Stops creating sessions. With cancel_future_sessions, its sessions that have not started are also called off, which cancels their bookings.',
        requestBody: requestBody(ref('StopSeriesInput'), { cancel_future_sessions: false }),
        responses: { 200: ok('The series, now stopped', ref('SeriesStopped')), 401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'), 413: errRef('E413'), 422: errRef('E422') },
      },
    },

    /* ---------------- Bookings ---------------- */
    '/api/v1/bookings': {
      get: {
        tags: ['Bookings'],
        summary: "List a user's bookings",
        parameters: [
          { name: 'user_id', in: 'query', required: true, schema: str({ minLength: 1, maxLength: 255 }), description: 'Your id for the end user.' },
          { name: 'from', in: 'query', schema: time(), description: 'Only bookings whose session starts at or after this time.' },
          { name: 'to', in: 'query', schema: time() },
          { name: 'order', in: 'query', schema: str({ enum: ['asc', 'desc'], default: 'asc' }) },
          { name: 'limit', in: 'query', schema: int({ minimum: 1, maximum: 500, default: 100 }) },
        ],
        responses: { 200: ok("The user's bookings, ordered by session start", arrayOf('Booking')), 400: errRef('E400'), 401: errRef('E401'), 403: errRef('E403'), 422: errRef('E422') },
      },
    },
    '/api/v1/bookings/{booking_id}': {
      parameters: [param('BookingId')],
      get: {
        tags: ['Bookings'],
        summary: 'Get a booking',
        responses: { 200: ok('The booking, with its session', ref('Booking')), 401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'), 422: errRef('E422') },
      },
    },
    '/api/v1/bookings/{booking_id}/cancel': {
      parameters: [param('BookingId')],
      post: {
        tags: ['Bookings'],
        summary: 'Cancel a booking',
        description: 'Gives its seats back. Allowed until min_cancel_notice_minutes before the session. Cancelling an already cancelled booking returns it unchanged.',
        responses: {
          200: ok('The booking, now cancelled', ref('Booking')),
          401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'),
          409: { description: 'booking_not_cancellable (attended or no-show) or cancellation_closed.', content: json(ref('Error')) },
          422: errRef('E422'),
        },
      },
    },
    '/api/v1/bookings/{booking_id}/check-in': {
      parameters: [param('BookingId')],
      post: {
        tags: ['Bookings'],
        summary: 'Record that a booking was attended',
        description: 'Marks it completed. Allowed from 60 minutes before the session starts. A no-show can be corrected this way.',
        responses: {
          200: ok('The booking, now completed', ref('Booking')),
          401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'),
          409: { description: 'booking_cancelled or attendance_not_open.', content: json(ref('Error')) },
          422: errRef('E422'),
        },
      },
    },
    '/api/v1/bookings/{booking_id}/no-show': {
      parameters: [param('BookingId')],
      post: {
        tags: ['Bookings'],
        summary: 'Record that a booking was not attended',
        description: 'Marks it no_show. Allowed from 60 minutes before the session starts. A check-in can be corrected this way. The seats stay taken.',
        responses: {
          200: ok('The booking, now no_show', ref('Booking')),
          401: errRef('E401'), 403: errRef('E403'), 404: errRef('E404'),
          409: { description: 'booking_cancelled or attendance_not_open.', content: json(ref('Error')) },
          422: errRef('E422'),
        },
      },
    },

    /* ---------------- Booking settings ---------------- */
    '/api/v1/settings': {
      get: {
        tags: ['Booking settings'],
        summary: 'Get your booking settings',
        description: 'Apply to every resource without a rule set of its own.',
        responses: { 200: ok('Your tenant booking settings', ref('Settings')), 401: errRef('E401'), 403: errRef('E403') },
      },
      put: {
        tags: ['Booking settings'],
        summary: 'Replace your booking settings',
        description: 'Replaces all three. A field you leave out, or send as null, is no longer enforced.',
        requestBody: requestBody(ref('Settings'), { min_lead_minutes: 60, max_horizon_minutes: 10080, min_cancel_notice_minutes: 30 }),
        responses: { 200: ok('The settings now stored', ref('Settings')), 401: errRef('E401'), 403: errRef('E403'), 413: errRef('E413'), 422: errRef('E422') },
      },
    },
  },
};

export const setupSwagger = (app) => {
  app.use(
    '/api-docs',
    swaggerUi.serve,
    // persistAuthorization keeps your token and key after a page reload
    swaggerUi.setup(swaggerSpec, { swaggerOptions: { persistAuthorization: true } }),
  );
  console.log('Swagger UI available at http://localhost:3000/api-docs');
};