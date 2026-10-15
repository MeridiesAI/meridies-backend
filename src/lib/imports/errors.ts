import { HttpError, conflict, forbidden, fromPostgrest, notFound } from "../errors.js";

/**
 * Errors from the import RPCs carry sentences we wrote for counselors
 * (request_import_commit, request_import_undo, request_held_apply and the
 * step-2 functions), so those messages are passed through; anything else
 * goes through fromPostgrest. Works for PostgREST and pg errors alike (both
 * carry code and message). MI001 (the invitation count) is the route's.
 */
export function fromImportRpc(error: { code?: string; message?: string } | null): HttpError {
  if (!error) return new HttpError(500, "Database error");
  const message = error.message ?? "";
  switch (error.code) {
    case "42501":
      return notFound("That import isn't on your account");
    case "55000":
      return conflict(message || "That import is busy");
    case "P0001":
      return new HttpError(410, message || "That's no longer possible");
    case "22023":
      return new HttpError(400, message || "That request isn't valid");
    case "28000":
      return forbidden();
    case "P0002":
      return notFound(message || "That isn't in this import");
    case "MI002":
      return forbidden(message || "You can't do that for this import");
    case "23514":
      return new HttpError(400, "That value isn't valid for this field");
    default:
      return fromPostgrest(error);
  }
}
