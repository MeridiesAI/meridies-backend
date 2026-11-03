import assert from "node:assert/strict";
import { test } from "node:test";
import { profileCandidates } from "../../src/lib/highSchoolProfile.js";

const cite = (url: string, title: string | null = null) => ({ url, title, citedText: "x" });

test("only a cited, seen, profile-looking http(s) URL is kept, PDFs first", () => {
  const got = profileCandidates({
    parts: [
      {
        text: "Found it",
        citations: [
          cite("https://ridge.example.org/about/profile"),
          cite("https://ridge.example.org/docs/2025-2026-School-Profile.pdf"),
          cite("https://ridge.example.org/news", "Ridge news"),
          cite("https://elsewhere.example.com/profile.pdf"),
          cite("javascript:alert(1)//profile"),
        ],
      },
    ],
    seenUrls: [
      "https://ridge.example.org/about/profile/",
      "https://ridge.example.org/docs/2025-2026-School-Profile.pdf#page=1",
      "https://ridge.example.org/news",
    ],
  });
  assert.deepEqual(got, [
    "https://ridge.example.org/docs/2025-2026-School-Profile.pdf",
    "https://ridge.example.org/about/profile",
  ]);
});

test("a URL the run never saw is never kept", () => {
  assert.deepEqual(profileCandidates({ parts: [{ text: "x", citations: [cite("https://a.example/profile.pdf")] }], seenUrls: [] }), []);
});
