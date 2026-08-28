/** Errors that carry an HTTP status through to the centralized error handler. */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const unauthorized = (m = "Unauthorized") => new HttpError(401, m);
export const forbidden = (m = "You don't have access to that") => new HttpError(403, m);
export const notFound = (m = "Not found") => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);
export const tooManyRequests = (m = "Too many requests — slow down") => new HttpError(429, m);
export const unavailable = (m: string) => new HttpError(503, m);

/**
 * Turn a PostgREST error into something safe to return. RLS denials surface as
 * empty results or 42501; either way the client is told "not found", never
 * "exists but you can't see it".
 */
export function fromPostgrest(error: { code?: string; message?: string } | null): HttpError {
  if (!error) return new HttpError(500, "Database error");
  switch (error.code) {
    case "PGRST116":
      return notFound();
    case "42501":
      return forbidden();
    case "23505":
      return conflict("That already exists");
    case "23503":
      return badRequest("That references something that doesn't exist");
    case "23514":
      return badRequest("That value isn't allowed");
    default:
      return new HttpError(500, "Database error");
  }
}
