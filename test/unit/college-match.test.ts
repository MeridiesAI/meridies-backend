// Which school a pasted research link is about (lib/collegeMatch.ts), for Files › Policy & research › <School>.
// Regression: https://mitadmissions.org/apply/firstyear/deadlines-requirements/, titled "MIT First-Year Application
// Deadlines & Requirements", was filed under General ("We didn't recognize a college in that link").
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMISSIONS_DOMAINS,
  hostWithin,
  schoolForAddress,
  schoolForResearch,
  schoolFromHost,
  schoolInText,
  siteHost,
  type CatalogSchool,
} from "../../src/lib/collegeMatch.js";

// The catalog's own shape (local seed rows: name, aka, website).
const CATALOG: CatalogSchool[] = [
  ["mit", "Massachusetts Institute of Technology", ["MIT"], "https://www.mit.edu"],
  ["cornell", "Cornell University", ["Cornell"], "https://www.cornell.edu"],
  ["penn", "University of Pennsylvania", ["Penn", "UPenn"], "https://www.upenn.edu"],
  ["psu", "Penn State University Park", ["Penn State", "PSU"], "https://www.psu.edu"],
  ["brown", "Brown University", ["Brown"], "https://www.brown.edu"],
  ["berkeley", "University of California, Berkeley", ["UC Berkeley", "Berkeley", "Cal"], "https://www.berkeley.edu"],
  ["union", "Union College", [], "https://www.union.edu"],
  ["jhu", "Johns Hopkins University", ["JHU", "Johns Hopkins", "Hopkins"], "https://www.jhu.edu"],
  ["cwru", "Case Western Reserve University", ["CWRU", "Case Western"], "https://case.edu"],
  ["umich", "University of Michigan", ["Michigan", "U-M", "UMich"], "https://umich.edu"],
  ["msu", "Michigan State University", ["MSU"], "https://msu.edu"],
  ["columbia", "Columbia University", ["Columbia"], "https://www.columbia.edu"],
  ["columbia-chicago", "Columbia College Chicago", ["Columbia"], "https://www.colum.edu"],
  ["nyu", "New York University", ["NYU"], "https://www.nyu.edu"],
  ["ox", "University of Oxford", ["Oxford"], "https://www.ox.ac.uk"],
].map(([id, name, aka, website]) => ({ id: id as string, name: name as string, aka: aka as string[], website: website as string }));

const idOf = (m: { id: string } | null) => m?.id ?? null;

test("addresses: the school's site, its subdomains, known admissions sites, and names in the path", () => {
  const cases: [string, string | null][] = [
    // The reported link.
    ["https://mitadmissions.org/apply/firstyear/deadlines-requirements/", "mit"],
    ["https://www.mitadmissions.org/blogs/entry/x", "mit"],
    ["https://mitadmissions.org.evil.example/apply", null],
    // The school's own domain, bare, with www, and any subdomain.
    ["https://www.mit.edu/admissions", "mit"],
    ["https://mit.edu/", "mit"],
    ["https://admissions.cornell.edu/apply/first-year", "cornell"],
    ["https://apply.jhu.edu/apply/deadlines", "jhu"],
    ["https://admissions.case.edu/", "cwru"],
    ["https://undergraduate.ox.ac.uk/courses", "ox"],
    // Look-alike hosts and a domain in the path or query are not the school's site.
    ["https://mit.education.example.com/x", null],
    ["https://notmit.edu/x", null],
    ["https://example.com/redirect?to=www.mit.edu", null],
    ["https://cornell.edu.example.com/", null],
    // A school's name or alias in the path.
    ["https://www.collegeessayguy.com/blog/cornell-supplemental-essays", "cornell"],
    ["https://example.com/guides/johns-hopkins-deadlines", "jhu"],
    // The longest name wins, and an alias two schools share is no match.
    ["https://example.com/penn-state-admissions", "psu"],
    ["https://example.com/penn-admissions", "penn"],
    ["https://example.com/michigan-state-university-visit", "msu"],
    ["https://example.com/columbia-deadlines", null],
    // Ordinary words are not schools.
    ["https://example.com/cal/events", null],
    ["https://example.com/credit-union-scholarships", null],
    ["https://example.com/submit/your-application", null],
    ["https://www.commonapp.org/apply/first-year-students", null],
  ];
  for (const [url, want] of cases) assert.equal(idOf(schoolForAddress(url, CATALOG)), want, url);
});

test("page titles: names, aliases as written, acronyms only in capitals", () => {
  const cases: [string, string | null][] = [
    // The reported page's title.
    ["MIT First-Year Application Deadlines & Requirements", "mit"],
    ["Massachusetts Institute of Technology | Admissions", "mit"],
    ["Apply | Cornell University Admissions", "cornell"],
    ["Penn State Admissions: First-Year Deadlines", "psu"],
    ["UPenn Early Decision Deadline", "penn"],
    ["Brown Admission: Requirements", "brown"],
    ["NYU Admissions", "nyu"],
    ["Union College Admissions", "union"],
    // Lower-case words that happen to spell an alias.
    ["Mit freundlichen Grüßen: deadlines", null],
    ["How now brown cow", null],
    ["Deadlines and requirements for first-year applicants", null],
    ["State university application requirements", null],
    ["Credit Union scholarship deadlines", null],
    ["Columbia admissions deadlines", null],
    ["", null],
  ];
  for (const [title, want] of cases) assert.equal(idOf(schoolInText(title, CATALOG, "title")), want, title);
});

test("file names still match a school's name or alias", () => {
  assert.equal(idOf(schoolInText("MIT_deadlines_2027.pdf", CATALOG, "filename")), "mit");
  assert.equal(idOf(schoolInText("cornell-profile.docx", CATALOG, "filename")), "cornell");
  assert.equal(idOf(schoolInText("notes.pdf", CATALOG, "filename")), null);
});

test("hosts: subdomains by whole labels, the most specific site, ties are no match", () => {
  assert.equal(siteHost("https://www.mit.edu"), "mit.edu");
  assert.equal(siteHost("www.cornell.edu/x"), "cornell.edu");
  assert.equal(siteHost("not a site"), null);
  assert.equal(siteHost(null), null);
  assert.equal(hostWithin("admissions.mit.edu", "mit.edu"), true);
  assert.equal(hostWithin("notmit.edu", "mit.edu"), false);
  const twoSites: CatalogSchool[] = [
    { id: "sys", name: "Example System", aka: [], website: "https://example.edu" },
    { id: "campus", name: "Example Campus", aka: [], website: "https://north.example.edu" },
  ];
  assert.equal(idOf(schoolFromHost("admissions.north.example.edu", twoSites)), "campus");
  assert.equal(idOf(schoolFromHost("www.example.edu", twoSites)), "sys");
  const twins: CatalogSchool[] = [
    { id: "a", name: "A", aka: [], website: "https://same.edu" },
    { id: "b", name: "B", aka: [], website: "https://www.same.edu" },
  ];
  assert.equal(schoolFromHost("same.edu", twins), null);
});

test("every admissions domain is a bare host that maps to a school's main domain", () => {
  for (const [host, site] of Object.entries(ADMISSIONS_DOMAINS)) {
    assert.match(host, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, host);
    assert.ok(!host.startsWith("www."), host);
    assert.equal(siteHost(site), site, `${site} is a bare main domain`);
    assert.ok(!hostWithin(host, site), `${host} is off ${site}, so it belongs in the map`);
  }
  assert.equal(idOf(schoolFromHost("mitadmissions.org", CATALOG)), "mit");
  // A mapped domain whose school isn't in this catalog is no match, never a guess.
  assert.equal(schoolFromHost("mitadmissions.org", CATALOG.filter((c) => c.id !== "mit")), null);
});

test("research filing: the address first, the page title only when it names no school", async () => {
  let fetched = 0;
  const title = (t: string | null) => async () => {
    fetched++;
    return t;
  };
  // The reported link is matched by its domain without fetching anything.
  const mit = await schoolForResearch({ url: "https://mitadmissions.org/apply/firstyear/deadlines-requirements/", pageTitle: title("x") }, CATALOG);
  assert.deepEqual(mit, { id: "mit", name: "Massachusetts Institute of Technology", by: "admissions-domain" });
  assert.equal(fetched, 0);
  // An unknown site is matched by its page's title.
  const viaTitle = await schoolForResearch({ url: "https://blog.example.org/post/123", pageTitle: title("MIT First-Year Application Deadlines & Requirements") }, CATALOG);
  assert.equal(viaTitle?.id, "mit");
  assert.equal(viaTitle?.by, "title");
  assert.equal(fetched, 1);
  // No title, a generic one, or a fetch that fails: General.
  assert.equal(await schoolForResearch({ url: "https://blog.example.org/a", pageTitle: title(null) }, CATALOG), null);
  assert.equal(await schoolForResearch({ url: "https://blog.example.org/a", pageTitle: title("Deadlines & Requirements") }, CATALOG), null);
  const failing = async () => {
    throw new Error("link_timeout");
  };
  assert.equal(await schoolForResearch({ url: "https://blog.example.org/a", pageTitle: failing }, CATALOG), null);
  // A file is matched by its name, never fetched.
  assert.equal((await schoolForResearch({ url: null, filename: "Cornell profile.pdf" }, CATALOG))?.id, "cornell");
});
