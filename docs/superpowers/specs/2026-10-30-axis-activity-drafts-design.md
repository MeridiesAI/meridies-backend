# AxIS: adding activities that stick (drafts, normalizers, confirm cards)

Status: design for review, 2026-10-30. Scope is project A of three (A: adding activities and following
multi-message directions; B: token cost and web research; C: security). B and C have their own sessions.

## 1. Why

Adding an activity to a student through AxIS takes several messages, fails, and then saves something
the counselor didn't say. Counselors stop trusting AxIS with changes after one of these. The same cause
sits under "AxIS is bad at following directions."

A real conversation (redacted; the student is "Student A", the organization "Code Club", the venue
"City Library"):

1. Counselor: "could you add that to his list?" → AxIS asks which list.
2. Counselor: "his activites sheet" → AxIS asks for organization, role, grades, timing, hours, for two activities.
3. Counselor sends the details with no verb: "Code Club / Cofounder/Teacher / Grade 11 Summer / 6hr week, 2 week/yr".
   AxIS says "my first attempt failed because I sent the grade as a number" (it hadn't tried yet), shows the
   row, and waits for a Confirm that doesn't exist.
4. Counselor: "i gave it" → AxIS tries once, is rejected (grade sent as the number 11, the API wants "11"),
   admits the earlier claim was false, and asks the counselor to "say the word" to retry.
5. Counselor: "City Library, please add it now" (answering where the workshop ran) → AxIS adds a *new* row:
   organization "City Library", position "Host, library workshop" (its own words), no grade, timing or
   hours. Code Club still isn't added. It also pulled a catalog passage about a university with the same
   town name.
6. Counselor: "Code Club took place at City Library, why is it called City Library not Code Club" → AxIS explains,
   tries to fix the row, is rejected again for the same number-grade error.
7. Counselor: "add code clubb" → Code Club is finally filed as a Confirm card (this time it needed Confirm,
   though AxIS had said it wouldn't) and saved. The wrong City Library row is still on the sheet.

Seven counselor messages, one wrong row saved, two false statements about what AxIS had done.

## 2. What caused it (confirmed in code and the transcript)

| # | Cause | Evidence |
|---|-------|----------|
| 1 | **Each message is classified on its own.** `understand()` (lib/axis/nlu.ts) scores intents from the message text only; the dialogue state carries students and colleges for pronouns, not "we are in the middle of adding an activity". A reply with details and no leading verb ("Code Club / Cofounder/Teacher …", "i gave it") scores as `record`: effort low, 3 model calls, and the direct-answer compiler may answer from the record with no model at all (engine.ts step 3). | Turns 3 and 4 each "Finished in 3 steps", the record profile's cap. |
| 2 | **The tool input must match exact formats, and the model gets one try.** `grade_levels` is an enum of strings ("9"…"12","PG"); the model sends numbers. Timing is one of school/break/year; "summer" isn't accepted. The rejection is raw zod text; the prompt says "fix the input once … otherwise tell the counselor." | Rejected three times on the number grade, across turns 4–6. |
| 3 | **Nothing checks that saved values came from the counselor.** The model wrote "Host, library workshop" itself, and put a venue in the organization field. `add_activity` is `risk: "auto"`: it saves at once with Undo, so the counselor sees the wrong row only after it's on the sheet. | Turn 5. |
| 4 | **The model narrates outcomes and policy from memory, not from results.** It claimed an attempt it hadn't made, and said no Confirm was needed right before one was (the turn had read outside content, so `run.ts` turned the add into a card). | Turns 3, 4, 6, 7. |
| 5 | **Entity noise.** "City Library" matched a college in the catalog index by its town name, and a catalog passage was gathered as evidence. | Turn 5 reply mentions the passage. |
| 6 | **Descriptions can't be saved at all.** `add_activity` leaves out `description` on purpose (essay guardrail: those are the student's words). The counselor's location detail had nowhere to go. | Turn 6. |

Not confirmed (no logs exist for it): exactly which intent each turn was given. Section 4.9 adds that logging.

## 3. Goals, non-goals, anti-goals

**Goals**
- A counselor can add an activity in one message, or across several messages in any order, and AxIS keeps
  going until it's saved, cancelled or expired.
- Ordinary ways of saying things ("sophomore", "grades 10–12", "summer", "6hr week") just work.
- Every activity AxIS adds or edits is shown on a card before it's saved, and every value on it is the
  counselor's own words or a direct conversion of them.
- When something can't be saved, the counselor reads one plain line saying what and why.
- A fixed set of conversations proves this before AxIS changes ship.

**Non-goals (v1)**
- The Awards & Honors sheet (built so it can reuse this later).
- UC description fields (`uc_description`, `uc_org_description`): still blocked.
- AxIS suggesting a category or UC category the counselor didn't say.
- Editing fields directly on the card (later; v1 has an Edit button, 4.6).
- Drafts for other kinds of changes (tasks, deadlines). The draft is built for activities only, but the
  state shape should allow other kinds later.
- Token cost, web research (project B); security review (project C).

**Anti-goals (a failure even if it "works")**
- AxIS saves any word the counselor didn't give it: a description, a position, an organization.
- More back-and-forth than today for a counselor who gives everything in one message.
- A raw validation error, or "say the word and I'll retry", reaches the counselor.
- AxIS says something was saved, tried or needs Confirm when the results say otherwise.

## 4. Design

### 4.1 The activity draft (per conversation)

**What it holds.** In `ai_conversations.state` (jsonb, ≤4000 bytes), a `draft` object:

```
draft: {
  kind: "activity",
  student_id,                      // fixed for the draft's life
  rows: [                          // up to 5 (a counselor often adds two or three at once)
    { key: "r1", op: "add" | "update", activity_id?,   // activity_id for an edit
      fields: { organization?, position?, grade_levels?, timing?, hours_per_week?, weeks_per_year?, continuing?, category?, uc_category? },
      status: "collecting" | "card" | "saved" | "dismissed",
      card_id? }
  ],
  opened_at, updated_at,
  expired?: true                   // set for one turn after a timeout (below)
}
```

Long text goes in a **new column**, `ai_conversations.draft_text` (jsonb, keyed by row: `{ "r1": { "description": "…" } }`,
size-checked, e.g. ≤12000 bytes). *(Elvin's decision: keep long text out of the 4000-byte slot.)*
Builder: `nextState()` and the engine currently rebuild `state` from scratch each turn (`{...nextState(), outside}`),
which would drop `draft`; carry it through explicitly.

**How it opens.** The model is told: when the counselor asks to add or change an activity, call
`application.add_activity` / `update_activity` right away with whatever it has, even partial. The server
keeps whatever fields pass (4.2–4.5) as a draft row and answers with what's missing or rejected. So the
first "add an activity" turn opens the draft, and every later message is routed by it.
*(My call. If eval conversation 2 shows the model asking for details without calling the op, the builder
adds a deterministic opener: action intent + "activity/activities" + a student in context opens an empty draft.)*

**While a draft is open (and not expired), every message in that conversation:**
- skips the direct-answer compiler (engine step 3);
- runs in `action` mode (the Clerk profile, 6 calls) whatever `understand()` scored;
- gets a short draft block added to the user turn, written by code: the student, each row's key, fields so far,
  missing fields, and card status. It goes in the user turn, not the system prompt, so the cached prefix doesn't move.
- still goes through the essay route if it's an essay request ("write a description for it"): the essay
  guardrail outranks the draft, and the draft stays open.
- A side question ("what's her GPA?") is answered in the same Clerk turn; the draft stays open.

**How it ends.**
- **Saved:** every row is `saved` or `dismissed` (the counselor confirmed or dismissed each card, or saved via Edit).
- **Cancelled:** a message matching a short code list ("cancel", "never mind", "forget it", "stop", "don't add it")
  closes the draft with a code-written reply: "Okay, I dropped the activity draft for Student A." Dismissing
  every card also closes it.
- **Timed out:** 30 minutes after `updated_at`. On the counselor's next message in that conversation, AxIS
  starts its reply with: "Your activity draft expired. Want to start again?" *(Elvin's decision.)* The expired
  fields are kept for that one turn; a yes ("yes", "yeah", "start again", "go ahead") reopens the draft with
  them, so nothing is retyped. Anything else drops it and the message is handled normally. *(Restoring the
  fields on yes is my call.)*

**When to ask.** A card can be filed once a row has an organization. If position, grades, timing, hours or weeks
are missing, AxIS asks once, in one message, naming only what's missing. If the counselor answers without them,
or says "add it" / "that's all", AxIS files the card with blanks; the card lists them. *(My call: today's
transcript shows the cost of asking repeatedly.)*

**Student.** A draft belongs to one student. If a message names a different student, AxIS asks whether to
move the draft or start a separate one. *(My call.)*

### 4.2 Normalizers (code, before validation)

The model's tool input passes through deterministic converters before the zod check. The same parsers also
read the counselor's messages for the provenance check (4.5).

| Field | Accepts | Becomes |
|-------|---------|---------|
| grade_levels | numbers (11), "11", "11th", "eleventh", "freshman/sophomore/junior/senior" (and "jr", "soph"), "PG", "post-grad"; ranges "10-12", "10–12", "10 to 12", "10 through 12", "9th-12th"; "all four years", "all of high school" | sorted, de-duplicated strings, e.g. ["10","11","12"] |
| timing | "school year", "during school", "after school", "fall", "spring semester" → school; "summer", "winter break", "spring break", "breaks" → break; "year-round", "all year", school + break together → year | one value |
| hours_per_week | "6", "6hr", "6 hrs/week", "6 hours a week", "6h", "about 6"; a range "5-6" → midpoint (5.5) | number. "2 hours a day" with no day count → ask (not guessed) |
| weeks_per_year | "2", "2 weeks/yr", "2 wk", "all year" → 52 | integer. "the school year" → ask |
| continuing | "still", "ongoing", "plans to continue" → true; "ended", "stopped", "no longer" → false | boolean |
| uc_category | only an explicit "volunteer", "work"/"job", "extracurricular", "educational prep" | enum |

*(The table is my call; the builder may add phrasings. Midpoint for ranges and 52 for "all year" are shown on the
card, so the counselor sees them before saving.)*

### 4.3 Validation messages

**To the model:** field by field, plain, with what's allowed and what to do. For example:
`hours_per_week: 200 is more than 168. Ask the counselor; don't guess. The other fields were kept in draft row r1.`
Replaces today's raw `zodText` for these ops. Valid fields are always kept in the draft. The prompt also says:
when the counselor asked for the change and the message says how to fix it, fix it and call again in the
same turn. Never ask the counselor's permission to retry.

**To the counselor:** the engine adds code-written status lines to the end of every reply where an activity op
ran (4.7), including "Couldn't save Code Club yet: hours per week can't be more than 168 (you said 200)."
Never raw error text, never silence.

### 4.4 Descriptions *(Elvin's decision)*

`description` is added to `add_activity` and `update_activity`. The server accepts it only when, after trimming
leading and trailing whitespace, it is an **exact, case-sensitive substring of one of the counselor's own messages
in this conversation**: typed messages only, not attachments, files, emails or tool results. Anything else is
rejected to the model with: "description must be the counselor's exact words; AxIS can't write or edit it."
AI-written descriptions stay blocked, so the essay guardrail holds.

- A description longer than the Common App's 150 characters still saves (the API allows 2000), but the card
  notes "Over the Common App's 150-character limit." *(My call.)*
- UC description fields stay blocked in v1. *(My call: smaller surface; same rule can extend later.)*
- Update the comments that say the sheets' free text is left out (catalog/application.ts header, `add_activity`
  title), `prose-guard` tests, and AGENTS.md's AxIS rules to describe the new exception.

### 4.5 Field provenance check

Before a card is filed, every value must trace back to the counselor's typed messages in this conversation:

- **Free text** (organization, position, category): a case-insensitive match after collapsing whitespace and
  punctuation. "code kidds adventure" and "Code Kids Adventure" both pass if both were typed; "Host, library workshop" fails.
- **Structured** (grades, timing, hours, weeks, continuing, uc_category): the value must be one the normalizers
  (4.2) produce from the counselor's messages.
- **For edits,** only the fields being changed are checked.
- A failing field is rejected to the model by name ("position 'Host, library workshop' isn't in the counselor's
  words; use their wording or leave it blank and ask"), and the rest of the row is kept.

Known limit: this can't catch a counselor's real words put in the wrong field. In the transcript, "City Library"
was typed by the counselor and was then saved as the organization. The **card** is the guard for that (4.6), and
eval conversation 11 checks the model gets it right.

### 4.6 Confirm card instead of save + Undo *(Elvin's decision)*

- `application.add_activity` and `application.update_activity` change from `risk: "auto"` to `"confirm"`
  (delete already confirms). The existing card, Confirm/Dismiss routes and post-confirm Undo are reused.
- The card shows every field it will save, a "Not given: …" line for blank fields, the description in full, and
  how a converted value was read ("Grades 10, 11, 12 (from 'grades 10–12')").
- **A correction while a card is pending** ("actually 8 hours") replaces it: the old card is dismissed with reason
  "replaced" and a new one is filed for the same draft row. One pending card per row.
- **A correction after saving** is an `update_activity` card on that row.
- **Edit button (app, meridies-app):** v1 adds an "Edit" button to activity cards. *(Elvin's decision.)* Open
  question 1 below covers what it opens: the app has no separate activity form, because the Activities sheet is
  edited inline (components/student/ApplicationSheets.tsx). The backend part (cards, drafts) works without the
  Edit button, so the app PR can land after.

### 4.7 Status lines written by code

After any turn where an activity op ran, the engine appends one line per draft row, built from the op results,
not the model's text:
- "Waiting for your Confirm: add Code Club to Student A's Activities sheet."
- "Saved: Code Club on Student A's Activities sheet." (after Confirm, on the next turn's recent-actions)
- "Couldn't save Code Club yet: <field>: <reason>."
- "Still need for City Library row: position, grades, hours."

The prompt tells the model: don't describe earlier attempts, and don't say whether a change needs Confirm or
has happened; the status lines do that. *(My call. It stops the false claims in turns 3, 4 and 6 without relying
on the model.)*

### 4.8 Smaller fixes found in the transcript

- **College noise while drafting:** with a draft open, a college matched only through a fragment of another name
  (a town in "City Library") isn't fetched as evidence unless the message asks a college question (a college
  attribute word is present). *(My call.)*
- **The model's wording:** the system prompt's "Making changes" section gets two lines: call the op with partial
  info rather than asking first, and never ask permission to retry a fixable error.

### 4.9 Logging *(Elvin's decision: category and path, no message text)*

One `axis turn` log line on every turn (today only the direct path logs one):
- `intent` (the category `understand()` picked) and `path` (direct / essay / agent / specialists). Elvin's decision.
- Also, *my call, strike if unwanted:* `draft` (none / opened / continued / expired / closed:saved|cancelled|timeout),
  op outcome codes (`filed`, `done`, `rejected:hours_per_week`; field names, never values), model calls used vs the
  cap, and the conversation id so a reported bad chat can be found.
- No message text, field values, student names or student ids.

### 4.10 The eval set

**Layer 1: every PR, in `npm test`, no API key.** Uses the scripted model in `test/unit/axis-fakes.ts`.
- Table tests for each normalizer, the description substring rule and the provenance check.
- Engine tests: an open draft skips the direct compiler and forces action mode; the essay route still wins;
  cancel; expiry line and restore; card replacement; status lines; draft survives `nextState`; long text
  goes to `draft_text`.
- The 15 conversations below with scripted model turns, to test the plumbing.

**Layer 2: the real model, on demand and on releases** *(Elvin's decision)*. Run before merging any PR that
touches `src/lib/axis/`, by someone clicking Run.
- New workflow `axis-eval.yml`: `workflow_dispatch` plus `release: published`. Same local Supabase setup as the
  CI integration job, seeded with made-up fixture students only. Never real data.
- Its own API key, `AXIS_EVAL_ANTHROPIC_API_KEY`, from a separate Console workspace with a spend limit (section 5).
  Note: prompt caches are per workspace, so eval runs won't warm or read production's cache.
- Each conversation is scored in code, not by a model: the sheet rows at the end equal the expected rows field
  by field; no extra rows; no counselor-visible text contains raw error text ("Invalid input", "Expected",
  zod paths); the number of AxIS questions is at or under the case's limit; draft state at the end is as expected.
- Pass bar: all 15 pass. A failed case is rerun twice and must pass 2 of 3, and any flaky case is reported as such.
  *(My call.)*

**The conversations (fixture student "Student A"):**

| # | Case | Expected |
|---|------|----------|
| 1 | Everything in one message | 1 card, all fields, no questions |
| 2 | "Add an activity for Student A" → AxIS asks → details with no verb, in the transcript's format | card with all fields after the 2nd message |
| 3 | "sophomore" | grades ["10"] |
| 4 | "grades 10–12" | ["10","11","12"] |
| 5 | Description given in the message | saved exactly as typed |
| 6 | "write a description for it" | refused by the essay guard; the row's other fields still filed; no description saved |
| 7 | "actually 8 hours" before Confirm | old card replaced, new card 8 |
| 8 | Rename after saving | update card on that row |
| 9 | "never mind" mid-draft | no rows, draft closed |
| 10 | Two activities in one go | 2 cards |
| 11 | "It ran at City Library" (venue) | organization stays "Code Club"; no invented position |
| 12 | Side question mid-draft, then more details | question answered; draft continues |
| 13 | Reply after 30 minutes | expiry line; "yes" restores the fields |
| 14 | "200 hours a week" | plain "couldn't save" line, no raw error |
| 15 | The redacted transcript replayed | Code Club saved once, correctly; no City Library row; ≤3 counselor messages after the details |

## 5. Rollout and steps for Elvin

**Order** *(Elvin's decision, same as before):* database change to production → backend PR → bcha's app PR.

1. **Migration** (`ai_conversations.draft_text`): safe to apply before the code, nothing reads it yet. Elvin
   pushes it from plain Terminal on main, dry-run first, as usual.
2. **Backend PR** (Elvin merges): drafts, normalizers, provenance, descriptions, cards, status lines, logging, evals.
   Works with or without the app's Edit button.
3. **App PR** (bcha reviews and merges): the Edit button.

**Setting up the eval key** (Elvin, once; checked against the Console docs 2026-10-30: spend limits are set on a
**workspace**, not on a key, and the Default Workspace can't have one):

1. Open https://platform.claude.com/settings/workspaces.
2. Click **Create workspace**.
3. Name it `axis-evals`, pick a color, click **Create workspace**. It appears in the list.
4. Click the `axis-evals` row. In the panel that opens, click **Spend limits**.
5. Set a monthly limit (suggestion: $20) and an alert at 50%, then save. *(The amount is my suggestion.)*
6. Open https://platform.claude.com/settings/keys, create a key, choose the `axis-evals` workspace, and name it
   `axis-eval-ci`. Copy the key. (The docs confirm keys belong to one workspace for life. The exact button
   label wasn't in the docs page checked.)
7. In GitHub, open meridies-backend → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
8. Name: `AXIS_EVAL_ANTHROPIC_API_KEY`. Paste the key into Secret. Click **Add secret**.

## 6. Decisions

**Elvin's:** the draft per conversation, its three endings and the expiry wording; long text in its own column;
normalizers before validation; field-level messages to the model and plain lines to the counselor;
descriptions only as exact substrings of the counselor's messages; confirm cards for adds and edits, with an
Edit button in v1; the provenance check; the eval set, run on demand and on releases with its own capped key
and fixture students only; logging of category and path with no text; the merge order.

**Mine (check these while reading):** the op call opens the draft (4.1); asking once and filing with blanks;
restoring fields on "yes" after expiry; one student per draft; up to 5 rows; the normalizer phrasings, range
midpoint and "all year" = 52; the 150-character note; UC descriptions stay blocked; status lines written by
code; skipping college evidence while drafting; the extra log fields; the eval pass bar; the $20 cap.

## 7. Open questions

1. *(Pending; see the summary sent with this document.)*

## 8. Prior art to reuse

- **Profile Update** (`lib/profileUpdates.ts`, the student's own AxIS) already does server-decided completeness
  for activity rows: `parseDraft`, `mergeDraft`, `missingFields`, `capDescription`, `currentGrade`. Reuse its
  merge and missing-field logic where the shapes match, rather than writing a second version.
- **Confirm cards** (`ops/run.ts`, `axis_actions`, `POST /axis/actions/:id/confirm|dismiss|undo`) and the
  card UI (meridies-app `components/assistant/AxisAnswer.tsx`) exist and are reused as they are.
- **Other guards stay in force:** `dispatch.ts`'s prose-key check (essay paths only; `description` isn't a prose
  key) and `proseRefusal` on every string a write files on a card. A description that passes the substring rule
  still has to pass `proseRefusal`.

## 9. Left to the builder

Names of new helpers and the column; where the normalizers live (suggest `lib/axis/ops/normalize.ts`); the exact
draft-block wording; the cancel and yes word lists; how a draft row key is passed to the op (suggest an optional
`draft_row` input); unit test layout; the eval runner script (`npm run eval:axis`).
