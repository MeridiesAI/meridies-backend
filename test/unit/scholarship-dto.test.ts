import assert from "node:assert/strict";
import { test } from "node:test";
import { toScholarship } from "../../src/lib/studentAid.js";

// A scholarship carries three links: the sponsor's own page (`url`), the page its facts were read from
// (`sourceUrl`), and, when the catalog has one, a separate place to apply (`applyUrl`). A student's "More info"
// and "Apply now" are told apart by them, so the DTO must say which is which and never invent one.

const base = { id: "s1", name: "Sample Scholarship" };

test("applyUrl is its own link: the application page, apart from the sponsor's page and the source", () => {
  const d = toScholarship({ ...base, url: "https://sponsor.example/about", apply_url: "https://sponsor.example/apply", source_url: "https://catalog.example/s1" });
  assert.equal(d.url, "https://sponsor.example/about");
  assert.equal(d.applyUrl, "https://sponsor.example/apply");
  assert.equal(d.sourceUrl, "https://catalog.example/s1");
});

test("with no separate application link applyUrl is null, and url and sourceUrl read as they always did", () => {
  const d = toScholarship({ ...base, url: "https://sponsor.example/about", apply_url: null, source_url: "https://sponsor.example/about" });
  assert.equal(d.applyUrl, null);
  assert.equal(d.url, "https://sponsor.example/about");
  assert.equal(d.sourceUrl, "https://sponsor.example/about");
});

test("a row with only an application link still has a url (as before) and applyUrl", () => {
  const d = toScholarship({ ...base, url: null, apply_url: "https://sponsor.example/apply", source_url: null });
  assert.equal(d.url, "https://sponsor.example/apply");
  assert.equal(d.applyUrl, "https://sponsor.example/apply");
  assert.equal(d.sourceUrl, null);
});

test("a row with no links at all has none of them", () => {
  const d = toScholarship({ ...base });
  assert.equal(d.url, null);
  assert.equal(d.applyUrl, null);
  assert.equal(d.sourceUrl, null);
});
