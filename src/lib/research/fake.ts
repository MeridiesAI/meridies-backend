/**
 * Test double for research (RESEARCH_FAKE=fixture). It is reached only through `seamFor` in run.ts, which also
 * refuses it when NODE_ENV is production, and the server refuses to boot with it set in production
 * (bootGuard.ts). It returns the same shapes as the real calls and never touches the network or a model.
 *
 * Each answer holds four cited candidates: one on a blocked domain, one whose URL the run never saw, and two good
 * ones, so the keeper's rules are exercised end to end.
 */
import type { ResearchResult } from "../anthropic.js";
import type { ResearchSeam } from "./run.js";

type Fixture = { title: string; summary: string; deadline?: string; cost?: string; url: string };

const ACTIVITIES: Fixture[] = [
  { title: "Listicle Summer Camp", summary: "A paid program found on a blocked site.", url: "https://www.niche.com/x" },
  { title: "Invented Research Program", summary: "Cited, but never searched or fetched in this run.", url: "https://invented.example/y" },
  { title: "Marine Science Program A", summary: "A summer marine science program for high school students.", deadline: "March 1", cost: "Free", url: "https://example.org/program-a" },
  { title: "Community Lab Program B", summary: "A volunteer research placement at a community lab.", deadline: "Rolling", cost: "$150", url: "https://example.org/program-b" },
];

const COLLEGES: Fixture[] = [
  { title: "Listicle Ranked College", summary: "Found on a blocked site.", url: "https://www.niche.com/colleges/x" },
  { title: "Invented College", summary: "Cited, but never searched or fetched in this run.", url: "https://invented.example/college" },
  { title: "Alpha Example College", summary: "A mid-size college with a strong biology program.", deadline: "January 15", url: "https://example.org/program-a" },
  { title: "Beta Example University", summary: "A university with undergraduate research in the sciences.", deadline: "November 1", url: "https://example.org/program-b" },
];

/**
 * Test hooks, reachable only here (the fake is never used in production): a focus of FOCUS_LEAK makes the fake issue a
 * search query holding the fixture student's school ("Lincoln High", the "full" fixture), to exercise the post-run
 * identity check; FOCUS_EMPTY makes the search find nothing.
 */
export const FOCUS_LEAK = "fixture:leak-query";
export const FOCUS_EMPTY = "fixture:empty";

export function fakeResearch(feature: "college_list" | "activities", focus: string | null = null): ResearchResult {
  const rows = focus === FOCUS_EMPTY ? [] : feature === "college_list" ? COLLEGES : ACTIVITIES;
  const parts = rows.map((r) => ({
    text: JSON.stringify({ title: r.title, summary: r.summary, deadline: r.deadline, cost: r.cost }),
    citations: [{ url: r.url, title: r.title, citedText: r.summary }],
  }));
  // Connective text with no citation: the parser must ignore it.
  if (rows.length) parts.unshift({ text: "Here are some options I found.", citations: [] });
  const seenUrls = rows.filter((r) => !r.url.startsWith("https://invented.example")).map((r) => r.url);
  return {
    parts,
    sources: rows.map((r) => ({ url: r.url, title: r.title })),
    runId: null,
    refused: false,
    queries: [
      feature === "college_list" ? "colleges strong biology undergraduate research" : "marine science summer programs high school",
      ...(focus === FOCUS_LEAK ? ["robotics programs near lincoln high school"] : []),
    ],
    seenUrls,
  };
}

export function fakeMatch(candidates: unknown[]): { picks: { index: number; why: string; effort: "medium" }[] } {
  return { picks: candidates.map((_, index) => ({ index, why: "Fits the student's interests", effort: "medium" as const })) };
}

export const fakeSeam: ResearchSeam = {
  model: "fake-fixture",
  research: async ({ feature, brief }) => fakeResearch(feature, brief.focus),
  match: async ({ kept }) => fakeMatch(kept),
  check: async () => ({ status: "ok" }),
};
