Hand-written fixtures for `test/unit/college-features.test.ts` (the college features ingest). They describe a
fictional "Example State University" at example.edu; none is a copy of a real site. Nothing here reaches the network.

- `robots.txt`: a `*` group with a Crawl-delay, a disallowed folder and an anchored Allow, another bot's group, and
  two Sitemap lines (one off the school's domain, which the crawler ignores).
- `sitemap-index.xml`, `sitemap-pages.xml`: a sitemap index (news, pages, and a CDATA-wrapped events child) and the
  pages sitemap, mixing topic pages with news, graduate, file, off-domain and robots-disallowed addresses.
- `home.html`, `honors.html`, `research.html`, `abroad.html`: pages with a `<nav>`, a `<main>` and a `<footer>`.
  `research.html` carries a line addressed to the model, which grounding treats as ordinary page text.
- `answer.json`: what the model might answer for the three topic pages: grounded items, plus a made-up quote, a
  quote cited to the wrong page, an unknown feature key, an unknown category, an out-of-range value, a name that
  isn't on its page, a description with a figure its page lacks, and duplicates.
