/**
 * Test double for the catalog proposer (RESEARCH_FAKE=fixture): canned pages for any school's domain and a canned
 * model answer, so the integration suite runs the real page picking, grounding and writes with no network and no
 * model. Reached only through `proposerDeps` in catalogProposalsRun.ts, which uses it only when
 * `researchFakeAllowed` (NODE_ENV development or test); the server refuses to boot with RESEARCH_FAKE otherwise.
 *
 * The answer holds three candidates the pages support (the personal statement is read, scores are self-reported,
 * supplement prompt 1) and two that must be dropped: supplement 2, whose quote is made up, and supplement 3, cited
 * from another domain. The home page also links to that other domain; fetching it throws.
 */
import type { AiCall } from "./collegeSiteInfo.js";
import type { SitePage } from "./links.js";

export const FAKE_PROMPT_1 = "Why do you want to attend our university, and what would you add to it?";
export const FAKE_STATEMENT = "Our readers review every applicant's Common App personal statement in full.";
export const FAKE_TESTING = "Applicants may self-report their SAT or ACT scores; official score reports are required only on enrolling.";

const meta = { title: null, description: null, images: [], icons: [] } as unknown as SitePage["meta"];

function domainOf(host: string): string {
  return host.toLowerCase().replace(/^(www|apply)\./, "");
}

export async function fakeFetchPage(url: string): Promise<SitePage> {
  const u = new URL(url);
  const domain = domainOf(u.hostname);
  if (domain.endsWith(".example") || !u.hostname.toLowerCase().endsWith(domain)) throw new Error(`the fake has no page at ${url}`);
  const path = u.pathname.replace(/\/+$/, "");
  if (path === "") {
    return {
      finalUrl: u.toString(),
      title: "Home",
      text: "Welcome. First-year applicants can find everything about applying on our admissions pages.",
      meta,
      links: [
        { href: `https://apply.${domain}/essays`, text: "Supplemental essays" },
        { href: `https://${u.hostname}/admissions/testing`, text: "Testing policy" },
        { href: `https://essays.example/${domain}/prompts`, text: "Essay prompts for this school" },
        { href: `https://${u.hostname}/athletics`, text: "Athletics" },
      ],
    };
  }
  if (u.hostname === `apply.${domain}` && path === "/essays") {
    return {
      finalUrl: u.toString(),
      title: "Supplemental essays",
      text: `Supplemental essays. Why us. Prompt 1: ${FAKE_PROMPT_1} (250 words) ${FAKE_STATEMENT}`,
      meta,
      links: [],
    };
  }
  if (path === "/admissions/testing") {
    return { finalUrl: u.toString(), title: "Testing", text: `Testing policy. ${FAKE_TESTING}`, meta, links: [] };
  }
  throw new Error(`the fake has no page at ${url}`);
}

/** The canned answer, pointed at the pages the prompt actually carried. */
export const fakeAi: AiCall = async (o) => {
  const urls = [...o.prompt.matchAll(/<page url="([^"]+)">/g)].map((m) => m[1]!);
  const essays = urls.find((u) => u.includes("/essays")) ?? "";
  const testing = urls.find((u) => u.includes("/admissions/testing")) ?? "";
  const answer = {
    personalStatementRead: { value: true, quote: FAKE_STATEMENT, sourceUrl: essays },
    testReporting: { value: "self-report", quote: FAKE_TESTING.slice(0, 60), sourceUrl: testing },
    supplements: [
      { sortOrder: 0, title: "Why us", prompt: FAKE_PROMPT_1, wordLimit: 250, quote: `Prompt 1: ${FAKE_PROMPT_1} (250 words)`, sourceUrl: essays, cycleStated: null },
      { sortOrder: 1, title: "A made-up prompt", prompt: "Describe a hat you love.", wordLimit: 100, quote: "Prompt 2: Describe a hat you love. (100 words)", sourceUrl: essays, cycleStated: null },
      { sortOrder: 2, title: "Off-site", prompt: FAKE_PROMPT_1, wordLimit: 250, quote: `Prompt 1: ${FAKE_PROMPT_1} (250 words)`, sourceUrl: "https://essays.example/prompts", cycleStated: null },
    ],
  };
  return o.validate(answer);
};
