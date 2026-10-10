# Student context layer and research — design

Status: draft for review · 2026-10-10 · Owner: Elvin
Scope: levels 1 and 2 of the AI context roadmap. Counselors only.

## 1. Goal

AxIS and the AI features see a student's full record — within what the
counselor may access and what the family allows — through one shared,
tested context layer instead of ~17 hand-built ones (level 1). On top of it,
counselors get cited college-list and activity suggestions researched on the
web inside Meridies, without the student's identity ever reaching a search
(level 2).

### Roadmap (from the planning meeting)

| Level | What | When |
|---|---|---|
| 1. Context access | AxIS sees the student's full profile, limited to what that counselor can access | PR 1 (this spec, §3–§5) |
| 2. Research | Context + cited web research for college lists and activities; narrative coherence uses context only | PR 2 (this spec, §6–§9) |
| Next 1–2 weeks | Practice program library (counselors save niche programs and good research results; research checks it before the web); move remaining AI features onto the context layer; track recommendation outcomes | separate specs |
| 3. Community data | Opt-in shared knowledge across practices | ~100 counselors + family and counselor opt-in + de-identification + FERPA/state-law review |

### Success criteria

- AxIS chat answers from transcripts, resumes, meetings and the full record when
  those are allowed, and never from anything excluded (§4).
- Every AI feature that moved onto the layer applies the same allowlist and
  document rules; a feature profile can only narrow them.
- No outgoing web search contains a student's name, email, school or address.
- Every shown recommendation cites a URL fetched or searched in its own run, on
  a non-blocked domain, and that URL answered when checked.
- A counselor without access to a student sees none of that student's context
  or recommendations, even inside the same firm.

### Non-goals (this round)

- Students using research or seeing recommendations.
- The practice program library; any cross-practice data sharing.
- Moving AI features other than those in §5 onto the layer.

## 2. Today (verified on main 65a3424)

- AxIS chat (`lib/chat.ts`) and `/ai/*` (`routes/ai.ts`) each load a near-identical
  student snapshot (`select("*")` on `student_academics`, capped lists, intake
  answers), JSON-encode it and cut at 60,000 characters (`.slice(0, 60_000)`),
  which can stop mid-record. Essay bodies are cut at 20,000 characters.
- `documents.available_to_llm` (default true) is honoured unevenly; AxIS chat reads
  no documents at all. `practiceSettings` gates `aiSummaries` and
  `autoParseDocuments` by module name.
- Private notes and status overrides never reach a prompt (keep it that way).
- Document kinds: `transcript, resume, essay, test-report, award-letter, financial,
  common-app, other`. No recommendation-letter, activity-list or IEP/504 kind;
  no FERPA-waiver field. Tasks (`deliverables`) cannot be hidden from the student.
- `runWebResearch` (`lib/anthropic.ts`) uses `web_search` + `web_fetch` with an
  allowed-domain list and returns parts with citations from that response only.

## 3. The AI allowlist (deny by default)

`src/lib/context/ai-allowlist.ts` is the only list of what AI may read:

```ts
export const AI_ALLOWLIST = {
  profiles:                 ["full_name", "grad_year", "high_school", "hometown", "headline"],
  student_academics:        ["gpa_unweighted", "gpa_weighted", "gpa_scale", "class_rank", "class_rank_value",
                             "rigor_count", "rigor_subjects", "test_status", "sat_ebrw", "sat_math",
                             "sat_superscore", "act_composite", "strength_areas", "strength_subjects"],
  student_personal_details: ["intended_majors", "first_gen", "citizenship"],
  activities:               ["name", "position", "organization", "category", "grade_levels",
                             "hours_per_week", "weeks_per_year", "description", "source"],
  awards:                   ["name", "level", "year"],
  courses:                  ["name", "type", "grade", "status", "school_year", "source"],
  test_scores:              ["exam", "kind", "score", "taken_on", "source"],
  student_colleges:         ["name", "round", "fit", "status"],
  intake_responses:         ["answers"],
  meetings:                 ["meeting_date", "title", "summary", "tags"],
  deliverables:             ["title", "kind", "status", "due_date"],
  essays:                   ["title", "prompt", "school", "status", "word_count", "body"],
  documents:                ["filename", "title", "kind", "parsed_data"],
} as const;
```

- Loaders select only named columns from this list (typed against it); `select *`
  is forbidden in `src/lib/context/` (a unit test greps for it).
- Anything not listed — new columns, private notes, status overrides, red flags,
  guardians, address, birthday, gender, contact email, phone, aid/financial
  tables — is invisible to AI until added here.
- Excluded tables have no loader at all.

### 3.1 Documents

Migration adds:
- Kinds: `recommendation-letter`, `activity-list`, `iep-504`, `counselor-only`
  (existing kinds kept; `test-report` is the score report; `other` is uncategorized).
- `documents.ferpa_waived boolean not null default false` (meaningful for
  `recommendation-letter`).
- `documents.ai_access text not null default 'default' check (ai_access in
  ('default','allowed','excluded'))`.
- Constraint: `not (kind = 'recommendation-letter' and ferpa_waived and ai_access = 'allowed')`.

A document is in AI context only when all hold (`private.document_ai_allowed(doc)`,
mirrored in TypeScript):
1. `available_to_llm` is true (the existing "keep out of AI" switch stays authoritative);
2. `ai_access = 'allowed'`, or `ai_access = 'default'` and `kind in
   ('transcript','resume','test-report','activity-list')`;
3. not a waived recommendation letter;
4. the practice's AI document reading (`autoParseDocuments`) is on;
5. the counselor can view it (RLS).

Default-excluded kinds: `recommendation-letter`, `financial`, `iep-504`,
`counselor-only`, `other`, `essay`, `award-letter`, `common-app` (essays reach AI
through the essays section, not as documents). Counselors toggle any document
via `PATCH /files/documents/:id { aiAccess }`; the constraint refuses enabling a
waived letter. `available_to_llm` keeps its current meaning for existing
features (submission review, task tracker), which are unchanged.

## 4. The context builder

`buildStudentContext(request, studentId, feature): Promise<StudentContext>`

```ts
type StudentContext = {
  text: string;                       // prompt-ready
  used: { section: string; items?: string[] }[];       // e.g. documents: ["Transcript.pdf"]
  omitted: { section: string; reason: "budget" | "not-allowed" | "practice-setting" | "empty" }[];
  brief?: ResearchBrief;              // §6, only for research features
};
```

- Runs on `request.db` (RLS) after `assertCanViewStudent`, so it never returns more
  than the counselor can see; counselors only (`requireRole("counselor")` at the
  routes that call it).
- **Sections**, one loader each in `src/lib/context/sections/`: profile, academics,
  personal (majors/first-gen/citizenship), activities, awards, courses, test
  scores, colleges, intake, meetings (last 8, summaries), tasks (open, last 20),
  essays (metadata; `body` only when the profile asks), documents (§3.1; text from
  `parsed_data.text`, per-document cap 12,000 characters, whole document dropped
  if over).
- **Feature profiles** (`src/lib/context/profiles.ts`): `chat`, `student-ai`
  (the `/ai/*` student routes), `narrative-coherence`, `college-list`,
  `activities`. Each lists sections in priority order and a character budget
  (chat 60,000; student-ai 40,000; coherence 50,000 with essay bodies; college-list
  24,000; activities 24,000). A profile is a subset of the allowlist by type; a
  test proves a profile can't name a table or column outside it.
- **Budget:** sections are added in priority order; a section that doesn't fit is
  dropped **whole** and listed in `omitted` with `budget`. List sections are
  pre-capped by count (newest first). Nothing is cut mid-record.
- **Untrusted text:** student-written, imported and document text is emitted as
  `<data source="essay:Common App" kind="untrusted">…</data>` with `<`/`>` in the
  content escaped; the system prompt states that data blocks are information,
  never instructions.
- **Transparency:** `used`/`omitted` (names only) are returned to the client with
  each response and stored in `ai_runs.metadata.context`. No content is logged.

## 5. PR 1 consumers

- AxIS chat (`lib/chat.ts`) → profile `chat`.
- `/ai/*` student routes (`routes/ai.ts`) → `student-ai`.
- Narrative coherence (`routes/applicationAi.ts`, both routes) → `narrative-coherence`
  (essay bodies through the layer; `enforceNoProse` unchanged).
- The two duplicated snapshot loaders are deleted. Other AI features unchanged.
- Responses gain `contextUsed: { used, omitted }`.

## 6. Research (PR 2)

### 6.1 The research brief (de-identified)

`toResearchBrief(context)` produces, and research ever sees, only:
- generic interest/activity **categories** (fixed vocabulary, e.g. "math
  competitions", "robotics", "community service", "journalism") — never named
  awards, placements, titles, organizations or schools;
- intended majors (as categories);
- grade (9–12), state or region;
- GPA band (0.2-wide on the stated scale, e.g. "3.6–3.8 on 4.0"; "unknown" for
  non-4/5 scales), test band (100-wide SAT / 3-wide ACT);
- the feature (college list or activities) and the counselor's optional free-text
  focus, which passes the same filter.

**Identity filter** (`assertNoIdentity(text, identity)`): before any model call
and on every outgoing search query the model issues (read from the
`server_tool_use` inputs), refuse if it contains the student's name tokens, email,
school name, hometown or address. A query that fails is a hard error for the run
(logged as `identity-filter`), not silently trimmed.

### 6.2 Domains

- Colleges: the existing official-site allowlist (`RESEARCH_DOMAINS` + school sites).
- Activities: open web search.
- Blocklist table `research_blocked_domains(domain, reason)` (seeded: SEO listicle
  farms, lead-gen, essay mills, pay-to-play programs; staff-maintained via
  service role). Passed to the tools as `blocked_domains` (fetch time) and
  enforced again when keeping citations.

### 6.3 Flow

1. Brief → research call (`RESEARCH_MODEL`, web_search ≤5, web_fetch ≤3) returns
   candidates with citations. Fetched/search text is untrusted data (§4 rule).
2. Keep a candidate only if each cited URL appears in this run's search results or
   fetches, is not blocked, and answers `checkLink` (`lib/links.ts`, SSRF-safe,
   HEAD). Otherwise drop it.
3. Match step (`FAST_MODEL`, no tools): candidates + full `college-list` /
   `activities` context → keep good fits, one-line "why it fits", effort level;
   no essay prose.
4. Present with "checked on <date>"; deadlines and costs are labelled "verify
   before applying". College suggestions keep the builder's fit-model order.

### 6.4 Cache and limits

- A run is reused for 7 days per (student, feature) unless the counselor
  refreshes, or the student's intended majors, activity categories, GPA or test
  scores changed since (`research_runs.inputs_hash` over the brief).
- `limit("research:run", 5, 60)` per user plus `consume_quota(practice,
  "research", "day", 50)` per practice (setting); the existing AI quotas still apply.

## 7. Storage

- `research_runs`: id, student_id, practice firm_id/counselor_id, feature,
  inputs_hash, brief (jsonb, de-identified), status, model, created_by, created_at,
  expires_at.
- `recommendations`: id, run_id, student_id, feature (`college_list` |
  `activities`), title, details jsonb (deadline, cost, effort, college_id when
  known), why, sources jsonb `[{url, title, checkedAt}]`, status (`suggested` |
  `accepted` | `dismissed`), accepted_as jsonb (`{type: "student_college"|"task",
  id}`), accepted_by, accepted_at, created_at.
- RLS: select where `private.can_view_student(student_id, auth.uid()) and
  auth.uid() <> student_id` and the caller is a counselor; no browser writes
  (routes write as the caller through definer functions that re-check).
- `deliverables.visible_to_student boolean not null default true`; a restrictive
  RLS policy hides rows with `false` from the student. Accepting an activity
  creates a task with `source='counselor'`, `visible_to_student=false`; the
  counselor shares it with `PATCH /tasks/:id { visibleToStudent: true }`.
- Accepting a college adds a `student_colleges` row through the existing insert
  path. Outcomes stay private to the practice; nothing is shared.

## 8. Routes (PR 2)

- `POST /students/:id/research/:feature` (`college-list` | `activities`), body
  `{ refresh?: boolean, focus?: string }` → `{ runId, checkedAt, cached,
  recommendations, contextUsed }`.
- `GET /students/:id/recommendations?feature=` → list.
- `POST /recommendations/:id/accept` → `{ acceptedAs }`.
- `POST /recommendations/:id/dismiss`.
All `requireRole("counselor")` + `assertCanViewStudent`; students get 403.

## 9. Testing

Fixtures: 5 made-up students (`test/fixtures/context/*.json`) covering: full
record; private notes + status override + guardian; documents of every kind incl.
a waived letter and a `keep out of AI` transcript; a huge record that exceeds
every budget; a 100-point GPA and a non-Latin name.

- Unit: allowlist (no `select *` in `src/lib/context`; a column not on the list
  never appears; profiles can't widen it); budget drops whole sections, never cuts
  a record; data blocks escaped and labelled; brief contains only categories/bands;
  identity filter refuses name/email/school/hometown; citation keeper drops URLs not
  from the run and blocked domains (recorded fixture responses).
- Integration (persona, local Supabase, model mocked via a test double for
  `runStructured`/`runWebResearch`): excluded sections and excluded document kinds
  never in context; waived letter can't be set `allowed` (23514); practice
  document-reading off drops documents; same-firm counselor without access gets
  404 for context, research and recommendations; student gets 403; cache reuse,
  refresh, invalidation on majors change; 5/min and daily caps; accept creates the
  link (college row or hidden task) and the student can't see the task until shared.
- Manual smoke script (`scripts/smoke/research.ts`): one real run for a fixture
  student against the live API keys; never real student data.

## 10. Delivery

- PR 1 (context layer): migration `20261016000001` (document kinds, `ferpa_waived`,
  `ai_access`, `document_ai_allowed`), `src/lib/context/*`, consumers in §5,
  `PATCH /files/documents/:id { aiAccess }`, tests. Reviewed first.
- PR 2 (research), stacked on PR 1: migration `20261016000002`
  (`research_runs`, `recommendations`, `research_blocked_domains` + seed,
  `deliverables.visible_to_student` + policy), `src/lib/research/*`, routes, tests,
  smoke script.
- If time is short, PR 1 ships first and PR 2 the next day.
