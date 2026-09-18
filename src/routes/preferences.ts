/**
 * The preference card sort.
 *
 * The deck is catalog data so two students' answers are comparable and a card
 * can be retired without rewriting anyone's history. `counselorNote` — why a
 * counselor cares about a card — is withheld from a student caller, because
 * showing it would coach the answer the card is trying to read.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { summarisePreferences, type DeckCard, type Rating } from "../lib/preferences.js";
import { toCardRating, toPreferenceCard } from "../lib/serialize.js";

type Row = Record<string, unknown>;

const studentQuery = z.object({ studentId: z.string().uuid().optional() });
const cardParam = z.object({ cardId: z.string().uuid() });
const ratingBody = z
  .object({
    studentId: z.string().uuid().optional(),
    rating: z.enum(["love", "good", "okay", "bad", "really-bad"]),
  })
  .strict();

export default async function preferenceRoutes(app: FastifyInstance) {
  /** The deck itself. */
  app.get("/", { preHandler: app.authenticate }, async (request) => {
    const deck = await loadDeck(request);
    const isStudent = request.profile.role === "student";
    return deck.map((card) => (isStudent ? { ...card, counselorNote: null } : card));
  });

  /**
   * A student's sort, plus the read-out. Both come back together because a
   * ratings map with no deck beside it is unreadable, and the client would
   * only have to ask for the deck next.
   */
  app.get("/ratings", { preHandler: app.authenticate }, async (request) => {
    const { studentId } = studentQuery.parse(request.query);
    const student = await resolveStudentId(request, studentId, "view");

    const [deck, ratings] = await Promise.all([loadDeck(request), loadRatings(request, student)]);
    const byCard = new Map<string, Rating>(
      ratings.map((r) => [r.cardId, r.rating] as [string, Rating])
    );

    return {
      studentId: student,
      ratings,
      summary: summarisePreferences(deck, byCard),
    };
  });

  /** Rate one card. Idempotent — re-rating replaces, it does not stack. */
  app.put(
    "/ratings/:cardId",
    { preHandler: [app.authenticate, limit("preference-cards:rate", 240, 60)] },
    async (request) => {
      const { cardId } = cardParam.parse(request.params);
      const body = ratingBody.parse(request.body);
      const student = await resolveStudentId(request, body.studentId, "edit");

      const { data: card, error: cardError } = await request.db
        .from("preference_cards")
        .select("id, is_active")
        .eq("id", cardId)
        .maybeSingle();
      if (cardError) throw fromPostgrest(cardError);
      if (!card || card.is_active !== true) throw notFound("That card isn't in the deck");

      const { data, error } = await request.db
        .from("student_preference_cards")
        .upsert(
          {
            student_id: student,
            card_id: cardId,
            rating: body.rating,
            rated_by: request.auth.userId,
          },
          { onConflict: "student_id,card_id" }
        )
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return toCardRating(data as Row);
    }
  );

  /** Un-rate. The card goes back to unsorted rather than to a middle value. */
  app.delete(
    "/ratings/:cardId",
    { preHandler: [app.authenticate, limit("preference-cards:clear", 120, 60)] },
    async (request) => {
      const { cardId } = cardParam.parse(request.params);
      const { studentId } = studentQuery.parse(request.query);
      const student = await resolveStudentId(request, studentId, "edit");

      const { error } = await request.db
        .from("student_preference_cards")
        .delete()
        .eq("student_id", student)
        .eq("card_id", cardId);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );
}

async function loadDeck(request: FastifyRequest): Promise<DeckCard[]> {
  const { data, error } = await request.db
    .from("preference_cards")
    .select("*")
    .eq("is_active", true)
    .order("category")
    .order("sort_order")
    .limit(200);
  if (error) throw fromPostgrest(error);
  return (data ?? []).map((r) => toPreferenceCard(r as Row));
}

async function loadRatings(request: FastifyRequest, student: string) {
  const { data, error } = await request.db
    .from("student_preference_cards")
    .select("*")
    .eq("student_id", student)
    .limit(200);
  if (error) throw fromPostgrest(error);
  return (data ?? []).map((r) => toCardRating(r as Row));
}
