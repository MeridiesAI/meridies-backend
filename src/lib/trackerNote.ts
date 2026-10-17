/**
 * The tracker's one-line note (deliverable_tracker_checks.note, 1–300 characters). The sentence about
 * unconfirmed attachments must survive the cap: the live-check caveat goes first, then the base is cut.
 */
export const TRACKER_NOTE_MAX = 300;

export function composeTrackerNote(base: string, unconfirmed: string, caveat: string, max = TRACKER_NOTE_MAX): string {
  const join = (parts: string[]) => parts.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
  const full = join([base, unconfirmed, caveat]);
  if (full.length <= max || !unconfirmed) return full;
  const withoutCaveat = join([base, unconfirmed]);
  if (withoutCaveat.length <= max) return withoutCaveat;
  const tail = unconfirmed.replace(/\s+/g, " ").trim();
  const room = max - tail.length - 2; // "…" and a space
  if (room <= 0) return tail.slice(0, max);
  return `${base.replace(/\s+/g, " ").trim().slice(0, room).trimEnd()}… ${tail}`;
}
