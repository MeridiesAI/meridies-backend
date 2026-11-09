# Curated data files

Checked-in CSVs for `scripts/ingest/curated-csv.ts`. Each row names a school by
IPEDS unitid and cites the page it came from (`source_url`) and the day it was
checked (`checked_on`).

| File | Dataset | Source | Covers |
|---|---|---|---|
| `css-profile-2027-28.csv` | `policies` (css_profile_required) | College Board, CSS Profile participating institutions, 2027-28 aid year | The 40 Meridies-profiled schools. `true` = on the list for undergraduates; `false` = not on it (a school's medical or law school alone doesn't count). |
| `supplements-2026-27.csv` | `supplements` | Each school's own admissions pages, read 2026-11-07 | 51 prompts for 9 schools. See "2026-27 compile" below. |
| `policies-flags-2026-27.csv` | `policies` (personal_statement_read, test_reporting, self_report_scores) | Each school's own admissions pages, read 2026-11-07 | 29 rows for 26 schools. See "2026-27 compile" below. |

Load: `npx tsx scripts/ingest/curated-csv.ts --dataset policies --file scripts/ingest/data/css-profile-2027-28.csv`

Add a file per dataset and cycle (e.g. `common-app-requirements-2026-27.csv`,
`uc-admits-by-discipline-fall-2025.csv`) and list it here.

### `policies`: personal statement and score reporting

Two more `policies` columns (migration `20261111000009_curated_flags.sql`),
each stamped in `sources` with the row's `source_url` and `checked_on`; blank
means unknown and leaves what an earlier row said:

- `personal_statement_read`: `true`/`yes` = the school reads the Common App
  personal statement, `false`/`no` = it doesn't.
- `test_reporting`: `official-only` (official report from the testing agency),
  `self-report` (the applicant types scores in; official on enrolling),
  `score-send` (official sends; self-report not accepted) or `not-applicable`
  (test-blind). It sits beside `self_report_scores`, which stays; a
  `self-report` school should also say `self_report_scores` = `true`.

Any other value is a row error, and a file with one row error loads nothing.

### `supplements`: supplement prompts

One row per published prompt, upserted into `college_supplements` on (school,
cycle, `sort_order`), so a re-run updates the same rows and never duplicates.
A prompt dropped from the file is **not** deleted (students' essays may point
at it); remove it by hand. Columns:

| Column | Required | Values |
|---|---|---|
| `unitid` | yes | IPEDS id; the school must already be in the catalog |
| `cycle` | yes | `2026-27` or `2026-2027` |
| `sort_order` | yes | 0, 1, 2 ... the prompt's place in the school's list; once per school and cycle in a file |
| `title` | yes | up to 120 characters |
| `prompt` | yes | the school's wording, up to 2000 characters |
| `word_limit` | no | 1-5000 |
| `scope` | no | `universal` (default), `major`, `scholarship` |
| `major_or_program` | no | up to 200 characters |
| `required` | no | `true`/`yes` (default) or `false`/`no` |
| `source_url` | yes | the school's own page, `https://` only |
| `checked_on` | yes | `YYYY-MM-DD`, the day someone read that page; stored as `source_verified_at` |

EXAMPLE only (a made-up school and URL; never load it):

```csv
unitid,cycle,sort_order,title,prompt,word_limit,scope,major_or_program,required,source_url,checked_on
999999,2026-27,0,EXAMPLE Why us,EXAMPLE: Why do you want to attend Example College?,250,universal,,yes,https://admissions.example.edu/EXAMPLE,2026-11-01
```

Load: `npx tsx scripts/ingest/curated-csv.ts --dataset supplements --file <csv> --dry-run`, then again without `--dry-run`.

## Events Hub listings

`scripts/ingest/events-csv.ts` loads Meridies-wide Events Hub listings
(`hub_events`) from a curator's CSV; columns are documented in
`src/lib/ingest/events.ts`, and `test/fixtures/events-sample.csv` shows the
shape (its rows are fake). Every listing needs the organizer's own page as
`url`. Name files by season (e.g. `events-2026-fall.csv`) and list them here.

Load: `npx tsx --env-file=.env scripts/ingest/events-csv.ts --file <csv> [--dry-run]`

| File | Source | Checked | Covers |
|---|---|---|---|
| `events-2026-fall.csv` | Each organizer's own event page (the row's `url`) | 2026-11-07 | 27 counselor conferences from IECA's Nov. 12-13, 2026 New York symposium through 2027 (kind `conference`, topic `practice`, audience left blank so counselors see them). Dates, place and name are as that page states them. Times are blank (all-day), and a multi-day event runs `start_date` to `end_date`. |

Organizers read for `events-2026-fall.csv` (a row only where the page states the
event's name, dates and place):

- **Rows:** NACAC (2027 conference, Asia Summit); IECA (2027 Annual Conference,
  Professional Member Retreat, Winter Forum, New York and European symposia);
  HECA (2027 annual conference); and 19 NACAC affiliates: Dakota, Great Plains,
  Hawaii, Illinois, Indiana, Iowa, Kentucky with Ohio (joint conference),
  Minnesota, New England, New York State, Pacific Northwest, Pennsylvania,
  Potomac & Chesapeake, Rocky Mountain, Southern, Texas, Western (WACAC),
  Wisconsin (also "WACAC") and International ACAC.
- **Read, no row:** NJACAC (its page shows only the May 2026 conference, which
  is past); MOACAC (the 2027 conference page says "stay tuned", no dates); OACAC
  (its own page still shows March 2026; the 2027 conference is the joint one
  with Kentucky above). Michigan's MACAC site refused an automated read (403),
  so it has no row. IECA's members-only calendar needs a login (reported by the
  compiler, not independently verified).
- **Left out on purpose:** past events (NACAC's Oct. 8-10, 2026 conference in
  Minneapolis), college fairs, and training institutes and half-day forums
  (HECA's January 2027 PDI, the affiliates' summer and winter institutes,
  Minnesota's January 2027 Winter Forum, International ACAC's Europe Regional
  Institute). Add them as their own kinds if the hub should list them.
- **What a row says:** `place` and `description` say only what the row's own
  `url` page states. Where a page names a venue or a city without a state, the row
  has just that (Punahou School; Keuka College; St. Paul College; Boise State
  University; Hershey Lodge & Convention Center; Hilton Cleveland Downtown,
  Cleveland), and the Kentucky-Ohio row spells its venue as that page does
  ("Cincinnati Marriot at RiverCenter"). A state code (FL, IL, IA, RI) only
  abbreviates a state the page spells out. `time_zone` is the zone of the stated
  place; the loader would otherwise default it to America/New_York, and these
  all-day rows show no clock time.
- **Dates that rest on a looser page:** TACAC's page says presenters must be
  available "either February 21 or February 22, 2027" and puts a regional college
  fair on Tuesday evening, February 23, "after the conference", so the row runs
  Feb. 21-22 (the page prints no single date range). The GPACAC row leaves out
  the conference's theme because the cited schedule page does not state it.
- **URLs:** the NACAC 2027 conference page's URL says `nacac-conference-2026` but
  the page is the 2027 event. IECA's European symposium event page is members-only,
  so its row points at IECA's public symposia page, which lists the dates. Dakota
  ACAC's row points at its landing page, where the 2027 save-the-date sits.
- **Not independently re-verified (bot-blocked for a second reader):** a second
  reader got a Cloudflare 403 on iecaonline.com (5 rows: "IECA Regional Symposium:
  Beyond the Traditional Path", "IECA Professional Member Retreat", "IECA Winter
  Forum", "IECA European Regional Symposium", "IECA 2027 Annual Conference"),
  nacacnet.org (2: "NACAC Asia Summit", "NACAC Conference 2027") and
  wacac.org/events (1: "WACAC (Western) 2027 Annual Conference"), and an Apache 406
  on rmacac.org (1: "RMACAC 2027 Annual Conference"). The compiler read all nine
  on 2026-11-07, but re-read them in a browser before a production load.

Refresh yearly: conference seasons are announced a year or so ahead, so each fall
re-read the same organizers' pages and add next season's file (e.g.
`events-2027-fall.csv`). Past events drop off the hub by themselves and the
loader never deletes, so a finished season's file can stay. Re-running a file is
safe (matched on name, host and start date); a changed date or name needs the old
row removed by hand. `test/unit/events-seed-file.test.ts` checks every
`events-*.csv` here and that each is listed above.

## Campus photos

`college-photo-picks.csv` is the team's say over which Wikimedia Commons file
is a college's campus photo (`scripts/ingest/college-photos.ts`,
`src/lib/ingest/collegePhotos.ts`). Columns: `unitid` (IPEDS, six digits),
`commons_title` (`File:...` as on Commons, or `none`), `note`.

- A title here wins over the college's Wikidata image, and may be narrower or
  squarer than the loader's size rule. It still has to be a JPEG under CC0,
  public domain, CC BY or CC BY-SA, with an author credit when the license
  needs one; a pick that fails those gets no photo.
- `none` suppresses a college: the loader never gives it a photo and removes
  the one it has. Use it for a wrong building, an aerial blur, or anything a
  counselor shouldn't see on a card.
- Seeded with the 43 photos hand-reviewed for the demo (meridies-app
  `lib/collegePhotos.json`). UCLA (110662), UC San Diego (110680) and San Jose
  State (122755) are not in the seeded catalog; their rows attach once the
  Scorecard load adds those schools.
- One bad row fails the whole file, and a run with an unreadable file stops
  before it changes anything.

Check a change with `npx tsx --env-file=.env scripts/ingest/college-photos.ts --dry-run --only <unitid>`.

## 2026-27 compile (11/7/26)

Compiled on 2026-11-07 from each school's own admissions pages (no Common App,
College Board or other third-party page is a source). Review before loading:
nothing here has been loaded anywhere; `--dry-run` against a local test
database shows 0 errors for both files. Every row's `checked_on` is the day its
`source_url` was read.

**How the schools were chosen.** Roster counts aren't available locally, so
"most applied-to" is a proxy, not a measurement: well-known schools among the 40
Meridies-profiled catalog schools (unitids from migration
`20261007000002_college_catalog_scorecard.sql`, the same ones the catalog holds),
leaving out the 8 whose supplements were already curated (Stanford, MIT, UC
Berkeley, Michigan, UT Austin, NYU, UW Seattle, Caltech). Those 8 were not
re-checked: in a local copy of the seed their prompts cite only the school's
home page and have no verified date. Of the 32 left, 26 have at least one
sourced fact below.

**`supplements-2026-27.csv`** (51 rows): Yale, Penn, Columbia, Dartmouth,
Boston College, Tufts, Johns Hopkins, Rochester, Swarthmore. Each page names the
cycle (2026-27, or "Class of 2031"). Conventions: prompt text is copied by
program from the page line (runs of spaces collapsed, an "A."/"1."/"Question 1:"
label dropped, word-count parentheticals kept as the school printed them; any
non-breaking or other unusual space, such as the narrow no-break space (U+202F)
in Penn's VIPER prompt, became one plain ASCII space and zero-width characters
were removed, so the file holds none of them);
`word_limit` is the stated maximum ("50-200 words" stores 200); pick-one prompts
are stored as separate non-required rows (one row per option, `required` false,
with "(choose 1 of N)" in the title: Yale's essay, Dartmouth's second and third
prompts, Boston College's first four); a school-, college- or program-specific
prompt has `scope` major and its name in `major_or_program`. Left out on
purpose: the Common App/Coalition personal statement prompts, transfer-only
essays, and questions that are a pick-list not writing (Yale's academic areas,
Huntsman's target language). Yale's short takes have a 200 *character* limit, so
`word_limit` is blank there.

**Withheld: Cornell supplements (17 prompts).** The eight college pages on
admissions.cornell.edu hold the prompts but never name a cycle, and the only
page that says "Fall 2027" is an FAQ article that shows "You are viewing the
article in preview mode. It is not live at the moment." A prompt we can't trace
to a live page dated for 2026-27 is not served, so none is in the file. What
would unlock it: Cornell's live 2026-27 (Fall 2027) writing-supplement prompts
page, one that names the cycle and is not a preview; re-read it and add the rows.
Cornell's `test_reporting` row stays: it comes from its live testing-policy page.

**`policies-flags-2026-27.csv`** (29 rows, one per source page, so a school can
have two): `test_reporting` is `self-report` where the page says applicants may
self-report scores (recruited athletes and international exceptions aside; the
same row sets `self_report_scores` true), and `score-send` for Rutgers
("Unofficial test scores cannot be accepted", so `self_report_scores` false).
`personal_statement_read` is `true` only where the page lists the personal
essay as part of the application or says the committee reads it. It has no
`false` values: no school's own page said it does *not* read the statement, and
silence is left blank, never read as "no".

**Downgraded in fix round 1: Ohio State and Pitt `test_reporting`.** Both were
first recorded as `official-only` ("Scores must come directly from the testing
agency", "Submit your Official SAT or ACT results (if applicable)"), but neither
page says outright that a self-report is refused, so the value is blank. Pitt
keeps its `personal_statement_read` row (its own sentence: the personal
statement "is your opportunity to communicate directly with the Admissions
Committee"); Ohio State's row only supported `test_reporting` and was dropped,
so Ohio State has no row.

**Not independently re-verified.** A second person re-fetched the pages on
2026-11-07 and found no mismatch, but these rows could not be re-fetched (the
sites refused a script) and rest on the compiler's own two fetches. A person
should check them in a browser before loading: Columbia's 6 supplement rows and
its 2 policy rows (403 to curl), the Johns Hopkins supplement row and policy row
and the Northeastern policy row (bot-blocked), and the Pitt policy row (bot
defense page).

**Two caveats on rows that are in the file.** Yale's three short takes and its
essay choice apply to Common App and Coalition applicants only (QuestBridge
applicants don't answer them), yet the short takes are marked `required` true.
Carnegie Mellon's testing page still says "fall 2026" (so no `test_reporting`
is recorded); the line the policy row rests on, that it considers the Common
Application essay, is not tied to a cycle.

**Not confirmed (left out, not guessed):**

- Supplement prompts not on the school's own page: Brown (says they are in the
  Common App "Questions" section), Boston University (names a supplemental essay,
  no prompt), Northeastern, Colgate and Hamilton (no prompt text on the page read;
  Hamilton lists its short answer as optional), Lehigh, Vassar, Bucknell, Syracuse,
  Case Western, Ithaca, UVM, Union (the
  Leadership in Medicine and Law short essays sit on pages that still show last
  year's figures and name no cycle), and the publics (Rutgers says no
  supplemental essays for the Common App; Ohio State, Penn State, Pitt,
  Binghamton). Cornell: prompts exist but are withheld (above).
- Carnegie Mellon: its page gives the three short-answer prompts but its testing
  paragraph says "fall 2026", so the page isn't shown to be updated for 2026-27;
  only the "we consider your Common Application essay" fact is recorded.
- No usable page found: Stony Brook, Buffalo, RIT (404 or home page), Hamilton and
  Ithaca flags. Case Western, Union, Carnegie Mellon, Pitt and Ohio State have no
  `test_reporting`.
- The 8 already-curated schools were not re-checked: their seed rows cite only
  the school's home page and have no verified date, so they are unverified here.
- Common App member pages load their requirements by script, so none were used.
