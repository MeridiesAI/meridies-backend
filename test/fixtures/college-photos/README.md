# College photo fixtures

Inputs for `test/unit/college-photos*.test.ts`, `test/integration/college-photos.test.mjs`
and `scripts/ingest/college-photos.ts --fixture-dir`. No test reaches the network.

**These were written by hand, not recorded.** The sandbox that built the loader
(2026-10-15) could not reach query.wikidata.org or commons.wikimedia.org, so the
files follow the documented response shapes instead:

- `wdqs-p1771.json`: a SPARQL 1.1 JSON results document from
  `https://query.wikidata.org/sparql` for
  `SELECT ?item ?unitid ?image ?modified WHERE { ?item wdt:P1771 ?unitid . OPTIONAL { ?item wdt:P18 ?image } OPTIONAL { ?item schema:dateModified ?modified } }`
  (P18 values as `http://commons.wikimedia.org/wiki/Special:FilePath/<name>`, spaces as `%20`;
  `modified` as an `xsd:dateTime` literal, every item 2026-08-01 here).
  The Q-ids other than the real universities' are made up.
- `commons-imageinfo-1280.json` / `-500.json`: `action=query&formatversion=2&redirects=1`
  answers (`prop=imageinfo|revisions|info`, `iiurlwidth=1280`,
  `iiprop=timestamp|url|size|mime|sha1|extmetadata` and `rvprop=timestamp`, each
  page with the `touched` time `prop=info` gives; and `prop=imageinfo`,
  `iiurlwidth=500`, `iiprop=timestamp|url|sha1`, the same version's sha1 and
  upload time as the 1280 answer, which the run compares after downloading), including a
  `normalized` entry (a decomposed accent Commons rewrites to NFC), a
  `redirects` entry (a moved file) and a `missing` page. The sha1s are
  sha1(title), not the files' own. Every upload time (imageinfo `timestamp`)
  and description-page revision (2026-06-01) is long past, so the review
  gate passes everything here except Penn, whose title is a redirect.
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

`review/`: the same answers after crowd edits dated 2026-10-14, for the review
gate (`test/unit/college-photos-run.test.ts`, `test/integration/college-photos-review.test.mjs`,
both reading them against a pinned "now" from 2026-10-15): Ithaca College
(191968) gets a main image that day, set on its item and uploaded the same
day, with a credit that is a spreadsheet formula; Colgate (190099) keeps its
main image but a new version of the file is uploaded over it (sha1 of
`"<title>#v2"`; the tests store `"#v1"`); Rochester's description page is
edited that day (a new credit, same file); and `File:Ithaca fresh pick.jpg`,
uploaded that day, is what `picks-ithaca.csv` picks. `picks-empty.csv` picks
nothing.

Re-record against the live services when the network allows, keeping the same
cases, and say so here.
