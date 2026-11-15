// Error with a status, a human message, and an optional machine-readable code.
export class ApiError extends Error {
  constructor(status, detail, code) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
}

export class ValidationError extends Error {
  constructor(detail) {
    super('validation failed');
    this.detail = detail;
  }
}

// True if any string (or object key) anywhere in the value holds a NUL character
function containsNul(value) {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(containsNul);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => k.includes('\u0000') || containsNul(v));
  }
  return false;
}

function parseWith(schema, value, where) {
  if (containsNul(value)) {
    throw new ValidationError([
      { type: 'string_invalid', loc: [where], msg: 'text must not contain a NUL character', input: null },
    ]);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        type: issue.code,
        loc: [where, ...issue.path],
        msg: issue.message,
        input: issue.input ?? null,
      })),
    );
  }
  return result.data;
}

export const parseBody = (schema, body) => parseWith(schema, body, 'body');
export const parseQuery = (schema, query) => parseWith(schema, query, 'query');
export const parseParams = (schema, params) => parseWith(schema, params, 'path');

export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    const body = { detail: err.detail };
    if (err.code) body.code = err.code;
    return res.status(err.status).json(body);
  }
  if (err instanceof ValidationError) {
    return res.status(422).json({ detail: err.detail });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ detail: 'request body is larger than 64 KiB' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(422).json({
      detail: [{ type: 'json_invalid', loc: ['body'], msg: 'JSON decode error', input: null }],
    });
  }
  console.error(err);
  res.status(500).type('text/plain').send('Internal Server Error');
}