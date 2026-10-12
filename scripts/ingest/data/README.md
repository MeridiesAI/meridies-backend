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
