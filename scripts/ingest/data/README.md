# Curated data files

Checked-in CSVs for `scripts/ingest/curated-csv.ts`. Each row names a school by
IPEDS unitid and cites the page it came from (`source_url`) and the day it was
checked (`checked_on`).

| File | Dataset | Source | Covers |
|---|---|---|---|
| `css-profile-2027-28.csv` | `policies` (css_profile_required) | College Board, CSS Profile participating institutions, 2027-28 aid year | The 40 Meridies-profiled schools. `true` = on the list for undergraduates; `false` = not on it (a school's medical or law school alone doesn't count). |

Load: `npx tsx scripts/ingest/curated-csv.ts --dataset policies --file scripts/ingest/data/css-profile-2027-28.csv`

Add a file per dataset and cycle (e.g. `common-app-requirements-2026-27.csv`,
`uc-admits-by-discipline-fall-2025.csv`) and list it here.

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
  so it has no row. IECA's members-only calendar needs a login.
- **Left out on purpose:** past events (NACAC's Oct. 8-10, 2026 conference in
  Minneapolis), college fairs, and training institutes and half-day forums
  (HECA's January 2027 PDI, the affiliates' summer and winter institutes,
  Minnesota's January 2027 Winter Forum, International ACAC's Europe Regional
  Institute). Add them as their own kinds if the hub should list them.
- **Notes on a few rows:** the NACAC 2027 conference page's URL says
  `nacac-conference-2026` but the page is the 2027 event. IECA's European
  symposium page is members-only, so its row points at IECA's public symposia
  page, which lists the dates. The state or city on a few rows is the named
  venue's, not spelled out on the page (Punahou School in Honolulu; Cleveland
  for HECA); the Kentucky-Ohio row keeps the page's "Cincinnati Marriott at
  RiverCenter".

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
