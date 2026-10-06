/**
 * The top-bar search.
 *
 *   GET /search?q=&limit=   students, invited students, colleges and open work
 *
 * One request for what the bar shows, each kind capped. Everything runs on the
 * caller's RLS-bound client, so a counselor only ever finds their own roster,
 * invitations and work items. Invited students ("Building profile": the
 * invitation hasn't been accepted, so there is no account yet) come back as
 * their own kind, because they have no student page to open yet.
 *
 * Students get colleges only.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COLLEGE_CARD_COLUMNS, escapeIlike, safeIlikeTerm, searchRank, toCollegeCard } from "../lib/collegesV10.js";
import { fromPostgrest } from "../lib/errors.js";
import { limit } from "../lib/limits.js";

type Row = Record<string, unknown>;

const query = z
  .object({
    q: z.string().trim().max(120),
    limit: z.coerce.number().int().min(1).max(20).optional(),
  })
  .strict();

export default async function searchRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [app.authenticate, limit("search", 240, 60)] }, async (request) => {
    const q = query.parse(request.query);
    const per = q.limit ?? 6;
    const term = safeIlikeTerm(q.q);
    const empty = { students: [], invitations: [], colleges: [], workItems: [] };
    if (!term) return empty;

    // The longest word narrows in SQL; the whole query ranks in code.
    const word = escapeIlike(term.split(" ").sort((a, b) => b.length - a.length)[0]);
    const like = `%${word}%`;
    const me = request.auth.userId;
    const counselor = request.profile.role === "counselor";

    const [students, invitations, colleges, workItems] = await Promise.all([
      counselor
        ? request.db
            .from("profiles")
            .select("id, full_name, email, profile")
            .eq("role", "student")
            .eq("counselor_id", me)
            .is("archived_at", null)
            .or(`full_name.ilike.${like},email.ilike.${like}`)
            .order("full_name")
            .limit(50)
        : Promise.resolve({ data: [] as Row[], error: null }),
      counselor
        ? request.db
            .from("invitations")
            .select("id, full_name, email, grad_year, created_at")
            .eq("counselor_id", me)
            .eq("status", "pending")
            .gt("expires_at", new Date().toISOString())
            .or(`full_name.ilike.${like},email.ilike.${like}`)
            .order("created_at", { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [] as Row[], error: null }),
      request.db.from("colleges").select(COLLEGE_CARD_COLUMNS).or(`name.ilike.${like},city.ilike.${like}`).limit(100),
      counselor
        ? request.db
            .from("counselor_work_items")
            .select("id, title, due_date, student_id")
            .eq("counselor_id", me)
            .eq("done", false)
            .ilike("title", like)
            .order("due_date", { ascending: true, nullsFirst: false })
            .limit(50)
        : Promise.resolve({ data: [] as Row[], error: null }),
    ]);
    for (const r of [students, invitations, colleges, workItems]) if (r.error) throw fromPostgrest(r.error);

    const matches = (...fields: unknown[]) => {
      const hay = safeIlikeTerm(fields.filter(Boolean).join(" ")).toLowerCase();
      return term.toLowerCase().split(" ").every((w) => hay.includes(w));
    };

    return {
      students: ((students.data ?? []) as Row[])
        .filter((s) => matches(s.full_name, s.email))
        .slice(0, per)
        .map((s) => {
          const profile = (s.profile ?? {}) as Record<string, unknown>;
          return {
            id: String(s.id),
            fullName: String(s.full_name ?? ""),
            email: String(s.email ?? ""),
            gradYear: profile.gradYear != null ? String(profile.gradYear) : null,
          };
        }),
      invitations: ((invitations.data ?? []) as Row[])
        .filter((i) => matches(i.full_name, i.email))
        .slice(0, per)
        .map((i) => ({
          id: String(i.id),
          fullName: i.full_name == null ? null : String(i.full_name),
          email: String(i.email),
          gradYear: i.grad_year == null ? null : Number(i.grad_year),
          invitedAt: String(i.created_at),
        })),
      colleges: ((colleges.data ?? []) as unknown as Row[])
        .map((r) => {
          const card = toCollegeCard(r);
          return { card, rank: searchRank(card.name, card.aka, [card.city ?? "", card.state ?? ""], q.q) };
        })
        .filter((x) => x.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.card.name.localeCompare(b.card.name))
        .slice(0, per)
        .map(({ card }) => ({ id: card.id, name: card.name, city: card.city, state: card.state, slug: card.slug })),
      workItems: ((workItems.data ?? []) as Row[])
        .filter((w) => matches(w.title))
        .slice(0, per)
        .map((w) => ({
          id: String(w.id),
          title: String(w.title),
          dueDate: w.due_date == null ? null : String(w.due_date),
          studentId: w.student_id == null ? null : String(w.student_id),
        })),
    };
  });
}
