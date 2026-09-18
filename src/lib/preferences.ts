/**
 * The subjective college-preference card sort.
 *
 * A student sorts 26 situations love -> really bad. The value to a counselor is
 * not the average; it is the handful of cards at the ends, because "I would
 * hate that" is the only thing in an intake that reliably survives contact with
 * a campus visit. So the read-out leads with the strong answers and reports
 * coverage honestly rather than scoring the deck.
 */

export type Rating = "love" | "good" | "okay" | "bad" | "really-bad";

export const RATINGS: Rating[] = ["love", "good", "okay", "bad", "really-bad"];

export type DeckCard = {
  id: string;
  key: string;
  category: string;
  categoryLabel: string;
  prompt: string;
  counselorNote: string | null;
  example: string | null;
  sortOrder: number;
};

export type PreferenceSummary = {
  sorted: number;
  total: number;
  /** The cards that carry information: rated "love" or "really bad". */
  strong: { cardId: string; key: string; prompt: string; rating: Rating }[];
  byCategory: { category: string; categoryLabel: string; sorted: number; total: number }[];
  /** One line a counselor can read without opening anything. */
  headline: string;
};

export function summarisePreferences(
  deck: DeckCard[],
  ratings: Map<string, Rating>
): PreferenceSummary {
  const strong: PreferenceSummary["strong"] = [];
  const categories = new Map<string, { categoryLabel: string; sorted: number; total: number }>();

  for (const card of deck) {
    const bucket = categories.get(card.category) ?? {
      categoryLabel: card.categoryLabel,
      sorted: 0,
      total: 0,
    };
    bucket.total += 1;

    const rating = ratings.get(card.id);
    if (rating) {
      bucket.sorted += 1;
      if (rating === "love" || rating === "really-bad") {
        strong.push({ cardId: card.id, key: card.key, prompt: card.prompt, rating });
      }
    }
    categories.set(card.category, bucket);
  }

  const sorted = deck.reduce((n, card) => n + (ratings.has(card.id) ? 1 : 0), 0);
  const loves = strong.filter((s) => s.rating === "love").length;
  const hates = strong.length - loves;

  return {
    sorted,
    total: deck.length,
    // Loves first: they are what a counselor opens the read-out looking for.
    strong: strong.sort((a, b) => (a.rating === b.rating ? 0 : a.rating === "love" ? -1 : 1)),
    byCategory: [...categories.entries()].map(([category, v]) => ({ category, ...v })),
    headline: headlineFor(sorted, deck.length, loves, hates),
  };
}

function headlineFor(sorted: number, total: number, loves: number, hates: number): string {
  if (total === 0) return "No cards in the deck yet.";
  if (sorted === 0) return "Not started — nothing to read yet.";
  if (sorted < total) {
    return `${sorted} of ${total} sorted · ${loves} loved, ${hates} ruled out so far.`;
  }
  if (loves === 0 && hates === 0) {
    // A fully sorted deck with nothing at either end is itself the finding.
    return "All sorted, nothing at either end — worth asking what would change that.";
  }
  return `All ${total} sorted · ${loves} loved, ${hates} ruled out.`;
}
