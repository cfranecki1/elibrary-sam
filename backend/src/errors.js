class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}
const badRequest = (msg='Validation failed', extra) => new ApiError(400, 'VALIDATION_ERROR', msg, extra);
const unauthorized = (msg='Authentication required') => new ApiError(401, 'UNAUTHORIZED', msg);
const forbidden = (msg='Forbidden') => new ApiError(403, 'FORBIDDEN', msg);
const notFound = (msg='Not found') => new ApiError(404, 'NOT_FOUND', msg);
const conflict = (msg='Conflict', code='CONFLICT', extra) => new ApiError(409, code, msg, extra);
module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict };
