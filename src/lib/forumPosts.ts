/**
 * Student Forums: the rules a post lives by.
 *
 * A student posts a thought, a video, a creator's page or a food spot about one college. Their own counselor
 * approves it before any other student can read it. Everything here is pure and imports nothing, so
 * `npm run check:forums` runs it under plain Node; `lib/forums.ts` keeps the posts and the pages draw them.
 *
 * Links are https only. A video or creator link must be on a short list of sites, matched on the host, and the
 * page draws it as a plain link card (no embed, and nothing fetches it).
 */

export type ForumKind = "thought" | "video" | "creator" | "food";
export type ForumStatus = "pending" | "approved" | "rejected" | "reported";

export type ForumPost = {
  id: string;
  authorId: string;
  /** First name only: a post never carries a last name. */
  authorFirst: string;
  authorYear: string | null;
  /** The author is one of the signed-in counselor's own students, so their posts reach this counselor's queue. */
  inCaseload: boolean;
  /** A key of `COLLEGE_NAMES` in `lib/events.ts`. */
  collegeId: string;
  kind: ForumKind;
  title: string;
  body: string;
  url: string | null;
  status: ForumStatus;
  /** The counselor's reason, set when a post is rejected or removed. */
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
  reportedAt: string | null;
};

export const FORUM_KINDS: readonly ForumKind[] = ["thought", "video", "creator", "food"];
export const KIND_LABEL: Record<ForumKind, string> = { thought: "Thought", video: "Video", creator: "Creator", food: "Food spot" };
export const KIND_PLURAL: Record<ForumKind, string> = { thought: "Thoughts", video: "Videos", creator: "Creators", food: "Food spots" };

export const TITLE_MAX = 80;
export const BODY_MAX = 600;
export const LINK_MAX = 2000;

const LINK_HOSTS = ["youtube.com", "youtu.be", "tiktok.com", "instagram.com"];
const SITE_NAME: Record<string, string> = { "youtube.com": "YouTube", "youtu.be": "YouTube", "tiktok.com": "TikTok", "instagram.com": "Instagram" };

/** The allowed site a host belongs to (the site itself or any subdomain of it), or null. `youtube.com.evil.example` is not. */
function allowedSite(host: string): string | null {
  const h = host.toLowerCase();
  return LINK_HOSTS.find((d) => h === d || h.endsWith(`.${d}`)) ?? null;
}

export type LinkResult = { ok: true; url: string | null } | { ok: false; message: string };

const bad = (message: string): LinkResult => ({ ok: false, message });

/** A video or creator needs a link; a thought or food spot may carry one. Returns the cleaned https address. */
export function checkLink(kind: ForumKind, raw: string): LinkResult {
  const text = raw.trim();
  const required = kind === "video" || kind === "creator";
  if (!text) return required ? bad(kind === "video" ? "Add a link to the video." : "Add a link to the creator's page.") : { ok: true, url: null };
  if (text.length > LINK_MAX) return bad("That link is too long.");
  // Any scheme other than https (http:, javascript:, data:, mailto:) is refused; a bare host gets https.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  if (hasScheme && !/^https:\/\//i.test(text)) return bad("Links have to start with https://.");
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    return bad("That doesn't look like a link.");
  }
  if (parsed.username || parsed.password) return bad("That doesn't look like a link.");
  if (required && !allowedSite(parsed.hostname)) return bad("Use a YouTube, TikTok or Instagram link.");
  return { ok: true, url: parsed.href };
}

export type Draft = { kind: ForumKind; collegeId: string; title: string; body: string; link: string };
export type DraftResult =
  | { ok: true; title: string; body: string; url: string | null }
  | { ok: false; field: "title" | "college" | "body" | "link"; message: string };

/** What a post needs before it can be sent: a title, a college, a body for a thought, and a good link. First problem wins. */
export function checkDraft(d: Draft): DraftResult {
  const title = d.title.trim();
  const body = d.body.trim();
  if (!title) return { ok: false, field: "title", message: "Add a title." };
  if (title.length > TITLE_MAX) return { ok: false, field: "title", message: `Keep the title to ${TITLE_MAX} characters.` };
  if (!d.collegeId) return { ok: false, field: "college", message: "Pick a college." };
  if (d.kind === "thought" && !body) return { ok: false, field: "body", message: "Write your thought." };
  if (body.length > BODY_MAX) return { ok: false, field: "body", message: `Keep it to ${BODY_MAX} characters.` };
  const link = checkLink(d.kind, d.link);
  if (!link.ok) return { ok: false, field: "link", message: link.message };
  return { ok: true, title, body, url: link.url };
}

/** "Maria · Class of 2027", or just "Maria" with no class year. A post never shows more than this. */
export function byline(p: { authorFirst: string; authorYear: string | null }): string {
  const year = p.authorYear?.trim();
  return year ? `${p.authorFirst} · Class of ${year}` : p.authorFirst;
}

/** A student with no counselor can read the forums but not post: nobody could approve it. */
export function canPost(counselorName: string | null | undefined): boolean {
  return Boolean(counselorName?.trim());
}

/** The words on a post's link card. */
export function linkLabel(kind: ForumKind, url: string): string {
  if (kind === "video" || kind === "creator") {
    try {
      const site = allowedSite(new URL(url).hostname);
      if (site) return `${kind === "video" ? "Watch on" : "Follow on"} ${SITE_NAME[site]}`;
    } catch {
      // not a link: fall through to the plain label
    }
  }
  return "Open link";
}

export function newPost(i: {
  id: string;
  authorId: string;
  authorFirst: string;
  authorYear: string | null;
  collegeId: string;
  kind: ForumKind;
  title: string;
  body: string;
  url: string | null;
  now: string;
}): ForumPost {
  const { now, ...rest } = i;
  return { ...rest, inCaseload: true, status: "pending", reviewNote: null, createdAt: now, updatedAt: now, reportedAt: null };
}

/**
 * Editing always sends a post back to the counselor, whatever state it was in, and clears the old note. A report is
 * kept: the counselor still has to see that another student flagged it, so an author can't wipe it by editing.
 * Only the counselor's decision answers a report.
 */
export function editPost(p: ForumPost, patch: Partial<Pick<ForumPost, "collegeId" | "kind" | "title" | "body" | "url">>, now: string): ForumPost {
  return { ...p, ...patch, status: "pending", reviewNote: null, updatedAt: now };
}

/**
 * The counselor's call on a pending, reported or approved post. Reject is also Remove (an approved post pulled
 * back) and needs a note; a post already rejected is left as it is.
 */
export function reviewPost(p: ForumPost, decision: "approve" | "reject", note: string, now: string): ForumPost {
  if (p.status === "rejected") return p;
  if (decision === "approve") return { ...p, status: "approved", reviewNote: null, reportedAt: null, updatedAt: now };
  const reason = note.trim();
  if (!reason) throw new RangeError("A rejection needs a note.");
  return { ...p, status: "rejected", reviewNote: reason, reportedAt: null, updatedAt: now };
}

/** A student can report a live post that isn't their own. Nothing else is worth reporting. */
export function canReport(p: ForumPost, viewerId: string): boolean {
  return p.status === "approved" && p.authorId !== viewerId;
}

/** Any student can report a live post; it leaves the feed at once and goes back to the author's counselor. */
export function reportPost(p: ForumPost, now: string): ForumPost {
  return p.status === "approved" ? { ...p, status: "reported", reportedAt: now, updatedAt: now } : p;
}

/** Only the author deletes a post. */
export function deletePost(posts: ForumPost[], id: string, authorId: string): ForumPost[] {
  return posts.filter((p) => !(p.id === id && p.authorId === authorId));
}

const newestFirst = (a: ForumPost, b: ForumPost) => b.createdAt.localeCompare(a.createdAt);
const oldestFirst = (a: ForumPost, b: ForumPost) => a.createdAt.localeCompare(b.createdAt);

/** What every student sees: approved posts only, newest first, narrowed by college and kind. */
export function feedFor(posts: ForumPost[], f: { collegeId?: string; kind?: ForumKind }): ForumPost[] {
  return posts
    .filter((p) => p.status === "approved" && (!f.collegeId || p.collegeId === f.collegeId) && (!f.kind || p.kind === f.kind))
    .sort(newestFirst);
}

/** A student's own posts in every state, newest first. */
export function mineFor(posts: ForumPost[], authorId: string): ForumPost[] {
  return posts.filter((p) => p.authorId === authorId).sort(newestFirst);
}

/**
 * The counselor's lists. Only their own students' posts reach them (the assigned counselor is the only reviewer).
 * To review is oldest first so nothing waits longest; Approved is newest first, for pulling one back.
 */
export function reviewQueue(posts: ForumPost[], tab: "review" | "approved"): ForumPost[] {
  return tab === "review"
    ? posts.filter((p) => p.inCaseload && (p.status === "pending" || p.status === "reported")).sort(oldestFirst)
    : posts.filter((p) => p.inCaseload && p.status === "approved").sort(newestFirst);
}

export function reviewCount(posts: ForumPost[]): number {
  return reviewQueue(posts, "review").length;
}
