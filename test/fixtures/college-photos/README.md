# College photo fixtures

Inputs for `test/unit/college-photos*.test.ts`, `test/integration/college-photos.test.mjs`
and `scripts/ingest/college-photos.ts --fixture-dir`. No test reaches the network.

**These were written by hand, not recorded.** The sandbox that built the loader
(2026-10-15) could not reach query.wikidata.org or commons.wikimedia.org, so the
files follow the documented response shapes instead:

- `wdqs-p1771.json`: a SPARQL 1.1 JSON results document from
  `https://query.wikidata.org/sparql` for
  `SELECT ?item ?unitid ?image WHERE { ?item wdt:P1771 ?unitid . OPTIONAL { ?item wdt:P18 ?image } }`
  (P18 values as `http://commons.wikimedia.org/wiki/Special:FilePath/<name>`, spaces as `%20`).
  The Q-ids other than the real universities' are made up.
- `commons-imageinfo-1280.json` / `-500.json`: `action=query&prop=imageinfo&formatversion=2&redirects=1`
  answers (`iiurlwidth=1280` with `iiprop=url|size|mime|sha1|extmetadata`, and
  `iiurlwidth=500` with `iiprop=url`), including a `normalized` entry (a
  decomposed accent Commons rewrites to NFC), a `redirects` entry (a moved
  file) and a `missing` page. The sha1s are sha1(title), not the files' own.
- `tiny.jpg`: an 8x5 JPEG, the bytes every fixture download returns.
- `picks.csv`: a picks file for the tests (Stanford picked over Wikidata,
  Binghamton picked narrower than the size rule, Stony Brook suppressed).

What each Wikidata binding exercises: MIT (CC BY-SA, HTML author), Stanford
(the pick wins), Cornell (one unitid on two items: skipped), Yale (no image),
Berkeley (a padded unitid, a title Commons normalizes), `12345` (not six
digits), Brown (two images: the alphabetically first), `199998`/`199999` (one
item claiming two unitids: skipped), Columbia (a PNG seal: refused), Dartmouth
(portrait), Lehigh (NC license), Tufts (personality restriction), Vassar
(NonFree), Bucknell (CC BY with no author), Union (deleted on Commons), Penn
(moved file, followed), Rochester (public domain, no author: "Unknown author"),
Swarthmore (an Attribution line that wins over Artist), Hamilton (a credit too
long to store: refused, not clipped), Binghamton (the pick wins).

Re-record against the live services when the network allows, keeping the same
cases, and say so here.
