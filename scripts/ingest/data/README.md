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
