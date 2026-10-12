/**
 * What an AxIS operation is.
 *
 * AxIS changes Meridies through the same HTTP routes the app calls, run
 * in-process (`app.inject`) with the counselor's own bearer token. So every
 * change passes the route's validation, `authenticate` (the approval gate),
 * the route's own authorization, its side effects (deadline mirroring,
 * notifications) and RLS, exactly as if the counselor had clicked it. An
 * operation only describes how to turn the model's input into that request,
 * how to label it for the counselor, and what the model may be told back.
 *
 * Reads are operations too (`kind: "read"`): they give AxIS the ids it needs
 * to change something, and their `reply` picks the few safe fields the model
 * may see. A write's default reply is the new row's id and nothing else, so a
 * route that echoes a whole row (a guardian, an address) never puts it in a
 * prompt.
 */
import type { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** One request to this API, as the counselor. `url` is a path with its query string, e.g. "/deadlines?studentId=…". */
export type OpCall = { method: HttpMethod; url: string; body?: unknown };

/**
 * auto: runs as soon as AxIS calls it, and the counselor gets an Undo.
 * confirm: AxIS files it as a card; nothing happens until the counselor clicks Confirm.
 *
 * Confirm is for anything that deletes or archives, sends or schedules a
 * message, shows something to a student or a family for the first time, moves
 * money, changes practice-wide settings or people, or can't be put back.
 */
export type Risk = "auto" | "confirm";

/** A reversal: another write operation in the catalog and its input. */
export type UndoStep = { op: string; input: Record<string, unknown> };

export type OpHelpers = {
  /** A roster student's name, for card text. Never sent to the model. */
  studentName(id: string | null | undefined): string;
  /** A GET through the API as the counselor; null on any failure. For labelling a target on a card. */
  get<T = unknown>(url: string): Promise<T | null>;
};

// The input type is erased in the registry; each definition is checked where it is written (see `op()`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpDef<I = any> = {
  /** "area.verb", e.g. "deadlines.create". Stable: saved proposals refer to it. */
  name: string;
  kind: "read" | "write";
  /** Writes only. A function when the tier depends on the input (a task shown to the student vs. kept hidden). */
  risk?: Risk | ((input: I) => Risk);
  /** One line for the catalog the model reads: what it does. */
  title: string;
  /** The input as the model writes it, compact: "{ student_id, title ≤300, due_date? YYYY-MM-DD }". */
  doc: string;
  /** Validates the model's input (snake_case). Keep it .strict(). */
  input: z.ZodType<I>;
  /**
   * The input carries `student_id`: it defaults to the chat's student when the
   * model leaves it out, and AxIS checks access to that student (edit access
   * for a write) before anything runs.
   */
  takesStudent?: boolean;
  /** The request this input becomes. */
  request: (input: I) => OpCall;
  /** Writes: one plain line for the card and the audit trail, naming the real target. */
  describe?: (input: I, h: OpHelpers) => string | Promise<string>;
  /** Writes: extra lines for the card (the new values, a message body). */
  details?: (input: I, h: OpHelpers) => string[] | Promise<string[]>;
  /** Confirm-tier writes: what is at stake, shown on the card. */
  warning?: string;
  /** What the model is told after it ran. Reads must define it and keep to safe fields. */
  reply?: (body: unknown, input: I) => string;
  /**
   * Writes: read what the write is about to change, before it runs, so `undo`
   * can put it back. Runs as the counselor (a GET through the API); null when
   * it can't be read, and then there is no undo.
   */
  snapshot?: (input: I, h: OpHelpers) => Promise<unknown>;
  /** The write that puts this one back, given what the API returned and the snapshot. */
  undo?: (input: I, body: unknown, before: unknown) => UndoStep | null;
};

export type OpGroup = {
  /** Catalog heading, e.g. "Deadlines". */
  heading: string;
  ops: OpDef[];
};

/** Writes a definition with its input type checked, then erases it for the registry. */
export function op<I>(def: OpDef<I>): OpDef {
  return def as OpDef;
}
