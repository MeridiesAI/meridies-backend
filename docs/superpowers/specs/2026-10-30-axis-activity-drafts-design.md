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

Not confirmed yet: exactly which intent each turn was given. Turns that ran the model (3–6 here) have it in
their `ai_runs` row (`input.intent`, `confidence`, `path`, `effort`; `output` has calls, tools and writes), which
Elvin can query on production. Direct and essay turns log nothing today; section 4.9 adds that.

## 3. Goals, non-goals, anti-goals

**Goals**
- A counselor can add an activity in one message, or across several messages in any order, and AxIS keeps
  going until it's saved, cancelled or expired.
- Ordinary ways of saying things ("sophomore", "grades 10–12", "summer", "6hr week") just work.
- Every activity AxIS adds or edits is shown on a card before it's saved, and every value on it is the
  counselor's own words, a file or note they pointed to, or a direct conversion of those, labelled with its source.
- When something can't be saved, the counselor reads one plain line saying what and why.
- A fixed set of conversations proves this before AxIS changes ship.

**Non-goals (v1)**
- The Awards & Honors sheet (built so it can reuse this later).
- UC description fields (`uc_description`, `uc_org_description`): still blocked.
- AxIS suggesting a category or UC category the counselor didn't say.
- Editing fields directly on the card or in a pop-up form (later; v1 has Save & edit, 4.6).
- Drafts for other kinds of changes (tasks, deadlines). The draft is built for activities only, but the
  state shape should allow other kinds later.
- Token cost, web research (project B); security review (project C).

**Anti-goals (a failure even if it "works")**
- AxIS saves a value that isn't in the counselor's messages, their attached files, their notes or the student's
  documents (4.5): a made-up position, organization or description. Descriptions come only from typed messages.
- More back-and-forth than today for a counselor who gives everything in one message.
- A raw validation error, or "say the word and I'll retry", reaches the counselor.
- AxIS says something was saved, tried or needs Confirm when the results say otherwise.

## 4. Design

### 4.1 The activity draft (per conversation)

**What it holds.** In `ai_conversations.state` (jsonb, ≤4000 bytes), a `draft` object:

```
// ai_conversations.state (the existing 4000-byte slot): only the small header
draft: {
  kind: "activity",
  student_id,                      // pinned for the draft's life (see "Pinned to its student")
  opened_at, updated_at,
  card_id?,                        // the pending add card, when one is filed
  expired?: true                   // set for one turn after a timeout (below)
}

// ai_conversations.draft_rows (new jsonb column, size-checked, e.g. ≤32000 bytes)
[                                  // up to 10 rows (the Common App lists 10 activities; a resume can fill them)
  { key: "r1", op: "add" | "update", activity_id?,     // activity_id for an edit
    fields: { organization?, position?, grade_levels?, timing?, hours_per_week?, weeks_per_year?, continuing?, category?, uc_category?, description? },
    sources: { <field>: "your message" | "Resume.pdf" | "meeting notes (Oct 12)" | … },
    status: "collecting" | "card" | "saved" | "dismissed" | "skipped" }
]
```

*(Elvin's decision: long text out of the 4000-byte slot. My call: all rows go in the new column, not only
descriptions, because a resume can fill ten rows.)*
Builder: three places would drop or lose `draft` today, and all three need changing. `nextState()` and the engine
rebuild `state` from scratch each turn (`{...nextState(), outside}`). `memory.ts`'s `stateSchema` strips unknown
keys on load. `saveState` runs after `done` as best effort, and a failure is only a warning. A draft change must be
saved before `done` is sent. If that save fails, the status line says so ("I couldn't keep this draft; send the
details again") rather than losing it silently. *(My call.)*

**How it opens.** The model is told: when the counselor asks to add or change an activity, call
`application.add_activity` / `update_activity` right away with whatever it has, even partial. The server
keeps whatever fields pass (4.2–4.5) as a draft row and answers with what's missing or rejected. So the
first "add an activity" turn opens the draft, and every later message is routed by it.
*(My call. If eval conversation 2 shows the model asking for details without calling the op, the builder
adds a deterministic opener: action intent + "activity/activities" + a student in context opens an empty draft.)*

**Open** means: at least one row is `collecting` or has a pending card, and the conversation has had a counselor
message in the last 30 minutes. `updated_at` moves on every counselor message in the conversation, not only on
draft changes, so a draft never expires while the counselor is still chatting. *(My call.)*

**While a draft is open, code sorts each message as part of the draft or unrelated** *(Elvin's decision,
2026-10-30: unrelated messages are answered normally and never captured)*.

A message **continues the draft** when any of these hold (checked in code, in this order):
1. it's a cancel, yes or continue word ("cancel", "never mind", "yes", "continue", "keep going");
2. a normalizer (4.2) finds an activity value in it: a grade, timing phrase, hours or weeks;
3. it names one of the draft's organizations or positions;
4. it starts with a correction cue ("actually", "no,", "wait", "make it", "change");
5. `understand()` scored `action`, or nothing scored above the fallback (a bare list of details, "i gave it").

Field words alone don't count ("what are her grades?" has no value in it), and numbers without an activity unit
don't count ("is her 1450 good for UCLA?"). *(The rule is my call; a unit-test table of 30+ messages pins it, and
the builder tunes it there.)*

A **draft message**:
- skips the direct-answer compiler (engine step 3) and runs in `action` mode (the Clerk profile, 6 calls);
- gets a short draft block added to the user turn, written by code: the student, each row's key, fields so far,
  each value's source, missing fields, and card status. It goes in the user turn, not the system prompt, so the
  cached prefix doesn't move.

An **unrelated message**:
- runs exactly as if no draft were open (its own intent and mode, direct answers allowed, no draft block);
- can't change the draft. Activity add and update ops are refused in that turn with "there's an open activity
  draft; ask the counselor to continue it", and nothing it says is merged in;
- ends with a code-written line: "You still have an activity draft for Student A. Continue or cancel?"
  "Continue" shows the draft's status and asks for what's missing; "cancel" cancels it.

Essay requests stay on the essay route either way. The lexicon doesn't catch "write a description for it" today
(it scores no intent and falls back to `record`), so add essay patterns for writing, drafting or rewriting an
activity description. Safety doesn't rest on the router: a description the model writes still fails 4.4.

**How it ends.**
- **Saved:** every row is `saved` or `dismissed` (the counselor confirmed or dismissed each card).
- **Cancelled:** a message matching a short code list ("cancel", "never mind", "forget it", "stop", "don't add it")
  closes the draft and dismisses its pending cards on the server, with a code-written reply: "Okay, I dropped
  the activity draft for Student A." Dismissing every card also closes it. *(Dismissing the cards is my call.)*
- **Timed out:** 30 minutes with no counselor message. On the next message in that conversation:
  - If the draft still had a row `collecting`, AxIS starts its reply with: "Your activity draft expired. Want to
    start again?" *(Elvin's decision.)* The expired fields are kept for that one turn; a yes ("yes", "yeah",
    "start again", "go ahead") reopens the draft with them, so nothing is retyped. *(My call.)* Any other message
    drops them and is handled normally, after the expiry line. If that message starts a new activity draft, the
    expired one is simply gone.
  - If every unsaved row was already a pending card, there's no expiry line. The draft closes and the cards stay
    valid; the counselor can still Confirm them. *(My call.)*

**When to ask.** A card can be filed once every row has an organization. If position, grades, timing, hours or
weeks are missing, AxIS asks once, in one message, naming only what's missing, row by row. If the counselor
answers without them, or says "add it" / "that's all", AxIS files the card with blanks; the card lists them.
*(My call: today's transcript shows the cost of asking repeatedly.)*

**Pinned to its student** *(Elvin's decision, 2026-10-30)*. One draft at a time, for one student, fixed when it
opens (in a student's chat, that student). Enforced in code, not by the prompt:
- While a draft is open, any activity add or update for a different student is refused before anything is
  filed. Nothing is saved onto the new student, and nothing from that message is merged into the open draft.
- AxIS then asks, in a code-written line: "Your activity draft for Student A isn't finished. Drop it and start
  one for Student B?" Yes cancels the old draft (as below) and opens a new one for Student B from that message.
  Anything else keeps Student A's draft, and Student B gets nothing.
- A question that only names another student ("what's Student B's GPA?") is an unrelated message (above).
- Tests: a unit test that the op is refused for a second student while a draft is open, and eval conversation 18.

### 4.2 Normalizers (code, before validation)

The model's tool input passes through deterministic converters before the zod check. The same parsers also
read the sources' text for the provenance check (4.5).

| Field | Accepts | Becomes |
|-------|---------|---------|
| grade_levels | numbers (11), "11", "11th", "eleventh", "freshman/sophomore/junior/senior" (and "jr", "soph"), "PG", "post-grad"; ranges "10-12", "10–12", "10 to 12", "10 through 12", "9th-12th"; "all four years", "all of high school" | sorted, de-duplicated strings, e.g. ["10","11","12"] |
| timing | "school year", "during school", "after school", "fall", "spring semester" → school; "summer", "winter break", "spring break", "breaks" → break; "year-round", "all year", school + break together → year | one value |
| hours_per_week | "6", "6hr", "6 hrs/week", "6 hours a week", "6h", "about 6"; a range "5-6" → midpoint (5.5) | number. "2 hours a day" with no day count → ask (not guessed) |
| weeks_per_year | "2", "2 weeks/yr", "2 wk", "all year" → 52 | integer. "the school year" → ask |
| continuing | "still", "ongoing", "plans to continue" → true; "ended", "stopped", "no longer" → false | boolean |
| uc_category | only an explicit "volunteer", "work"/"job", "extracurricular", "educational prep" | enum |
| category | the counselor's words matching one of the app's 27 Common App types (`ACTIVITY_TYPES`, meridies-app `lib/applicationSheets.ts`) by name or a short synonym table ("community service" → "Community Service (Volunteer)", "robotics" → "Robotics") | that type's exact label. No match: left blank, never saved as off-list text |

The category mapping counts as a conversion, like "sophomore" → "10", not as AxIS suggesting a category: it only
happens when the counselor said something that names the type. The card shows "Category: Community Service
(Volunteer) (from 'community service')". *(My call.)*

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

`description` is added to the activity ops. The server accepts it only when, after trimming leading and trailing
whitespace, it is an **exact, case-sensitive copy** from one of two sources, checked in code:
- **one of the counselor's typed messages in this conversation**, labelled "from your message";
- **the student's own Meridies documents** *(Elvin's decision, 2026-10-30)*, labelled "from resume" (or the
  document's kind, e.g. "from activity list"). The text is checked against the document's full extracted text,
  read on the counselor's client through `documentAiDecision`, so a file the AI may not read can't be a source.
  *My calls:* only kinds `resume` and `activity-list` count, so an essay file can't feed a description. For the
  comparison, every run of whitespace (PDF line breaks) collapses to one space on both sides; nothing else is
  loosened. Files attached only in the chat don't count for descriptions in v1; the counselor can file the resume
  to the student's documents.

Anything else is rejected to the model with: "description must be copied exactly from the counselor's message or
the student's resume; AxIS can't write or edit it." AI-written descriptions stay blocked, so the essay guardrail
holds. `proseRefusal` still runs on it.

- A description longer than the Common App's 150 characters still saves (the API allows 2000), but the card
  notes "Over the Common App's 150-character limit." *(My call.)*
- The card must show it whole. `runWrite` cuts each card detail line at 1600 characters (`ops/run.ts`), so either
  raise that cap to 2000 for the description line or refuse descriptions over 1600 with a plain message. Builder's
  choice, as long as a card never shows a cut description.
- UC description fields stay blocked in v1. *(My call: smaller surface; same rule can extend later.)*
- Update the comments that say the sheets' free text is left out (catalog/application.ts header, `add_activity`
  title), `prose-guard` tests, and AGENTS.md's AxIS rules to describe the new exception.

### 4.5 Field provenance check

**Sources that count** *(Elvin's decision, 2026-10-30: messages, files and notes)*:
- the counselor's typed messages in this conversation;
- files the counselor attached in this chat: text files, and PDFs through their extracted text (`lib/pdfText.ts`).
  *My call:* images don't count in v1, because the server can't read their text back. A value only in an image is
  rejected with "ask the counselor to type it or attach a PDF or text file";
- the counselor's own meeting notes (already in the trusted record);
- the student's Meridies documents that AxIS read in this conversation, through passages the AI may read
  (`documentAiDecision` already applies).

*My call:* these don't count: AxIS's own earlier answers, emails, intake answers, other record fields the student
wrote, and anything from the web. **Descriptions have their own, narrower rule** (4.4). Each value on the card
names its source: "from your message", "from Resume.pdf", "from meeting notes (Oct 12)". A card with any value
from a file or document is flagged (4.11).

Before a card is filed, every value must trace back to one of those sources:

- **Free text** (organization, position): a case-insensitive match after collapsing whitespace and
  punctuation. "code kidds adventure" and "Code Kids Adventure" both pass if both were typed; "Host, library workshop" fails.
- **Structured** (grades, timing, hours, weeks, continuing, uc_category, category): the value must be one the
  normalizers (4.2) produce from a source's text.
- **For edits,** only the fields being changed are checked.
- A failing field is rejected to the model by name ("position 'Host, library workshop' isn't in the counselor's
  words; use their wording or leave it blank and ask"), and the rest of the row is kept.

Known limit: this can't catch a counselor's real words put in the wrong field. In the transcript, "City Library"
was typed by the counselor and was then saved as the organization. The **card** is the guard for that (4.6), and
eval conversation 11 checks the model gets it right.

### 4.6 Confirm card instead of save + Undo *(Elvin's decision)*

- `application.add_activity` and `application.update_activity` change from `risk: "auto"` to `"confirm"`
  (delete already confirms). The existing card, Confirm/Dismiss routes and post-confirm Undo are reused.
- **One card per draft, a row per activity** *(Elvin's decision, 2026-10-30)*. Adds in a draft are filed as a
  single card, through a new op (suggested `application.add_activities`, `{ student_id, rows: [...] }`, ≤10 rows,
  `confirm`), with one row per activity and **a checkbox per row, checked by default**. Confirm saves the checked
  rows, one `POST /application/activities` each, and records a result per row. Undo deletes the rows that card
  saved. Unchecked rows are `skipped` and the draft closes. *(My call: skipped rows are dropped, not kept.)*
  - `POST /axis/actions/:id/confirm` takes an optional `{ rows: ["r1","r3"] }` for this op only. Without it (the
    app before its PR), every row is saved.
  - A row the route refuses (e.g. the sheet's 30-row cap) shows its own reason; the others still save.
  - Edits to an existing activity stay one `update_activity` card each. *(My call.)*
- Each row shows every field it will save with its source, a "Not given: …" line for blank fields, the description
  in full, and how a converted value was read ("Grades 10, 11, 12 (from 'grades 10–12')").
  - The payload carries the rows as structured data for the app's checkbox rows. For the app as it is today, the
    detail lines are one compact line per row ("Code Club · Cofounder/Teacher · 11 · break · 6 h/wk · 2 wk/yr
    · from your message"). That fits `runWrite`'s 12-line limit at 10 rows. Builder: make sure no value is cut.
- **A correction while a card is pending** ("actually 8 hours") replaces it: the old card is dismissed with reason
  "replaced" and a new one is filed with every row, all checked. One pending add card per draft. The backend sends the old
  card's new status as a live `action` event. Today the app only redraws pending and executed cards live
  (`LIVE_OPERATION_STATUSES` in meridies-app `lib/axisSse.ts`) and knows only two reasons, so until the app PR
  teaches it `dismissed` and the `replaced` reason, the old card keeps its Confirm button until the chat reloads.
  Clicking it then gets the existing 409 "That proposal was already handled", so nothing is added twice.
  That's acceptable for the gap between the two PRs. *(My call.)*
- **A correction after saving** is an `update_activity` card on that row.
- **Save & edit button (app, meridies-app):** *(Elvin's decision, 2026-10-30.)* The app has no separate activity
  form; the Activities sheet is edited inline (`components/student/ApplicationSheets.tsx`). So the card's extra
  button **confirms the card as shown (the checked rows), then opens the student's Activities sheet with the new
  rows highlighted**,
  where every cell is already editable and saves on change. Undo on the card still works. *My call:* label it
  "Save & edit", not "Edit", so it's clear the row is saved first. Dismiss stays the way to stop a wrong row
  entirely. Builder: the confirm response must carry the new rows' ids (check `POST /axis/actions/:id/confirm`'s
  answer; add them if missing), and the sheet needs a way to scroll to and highlight rows. No new
  confirm-with-changes path. The backend part (cards, drafts) works without the button, so the app PR can land after.

### 4.7 Status lines written by code

After any turn where an activity op ran, the engine appends one line per draft row, built from the op results,
not the model's text:
- "Waiting for your Confirm: add Code Club to Student A's Activities sheet."
- "Saved: Code Club on Student A's Activities sheet." (after Confirm, on the next turn's recent-actions)
- "Couldn't save Code Club yet: <field>: <reason>."
- "Still need for City Library row: position, grades, hours."

The model is told, only for activity ops and only in turns where status lines will be added: don't describe
earlier attempts, and don't say whether a change needs Confirm or has happened; the status lines do that. This
goes in the code-written draft block, not the global system prompt, so other ops keep today's "say it is
waiting" behavior. *(My call. It stops the false claims in turns 3, 4 and 6 without relying on the model.)*

### 4.8 Smaller fixes found in the transcript

- **College noise while drafting:** with a draft open, a college matched only through a fragment of another name
  (a town in "City Library") isn't fetched as evidence unless the message asks a college question (a college
  attribute word is present). *(My call.)*
- **The model's wording:** the system prompt's "Making changes" section gets two lines: call the op with partial
  info rather than asking first, and never ask permission to retry a fixable error.

### 4.9 Logging *(Elvin's decision: category and path, no message text)*

One `axis turn` log line on every turn (today only the direct path logs one):
- `intent` (the category `understand()` picked) and `path` (direct / essay / agent / specialists). Elvin's decision.
- Also, *my call, strike if unwanted:* `draft` (none / opened / continued / unrelated / expired / closed:saved|cancelled|timeout),
  op outcome codes (`filed`, `done`, `rejected:hours_per_week`; field names, never values), model calls used vs the
  cap, and the conversation id so a reported bad chat can be found.
- No message text, field values, student names or student ids.

### 4.10 The eval set

**Layer 1: every PR, in `npm test`, no API key.** Uses the scripted model in `test/unit/axis-fakes.ts`.
- Table tests for each normalizer, the description rule (typed messages and resume copies, whitespace collapse,
  essay-kind documents refused) and the provenance check.
- A table of 30+ messages for the draft/unrelated sorter (4.1).
- Engine tests: a draft message skips the direct compiler and runs in action mode; an unrelated message runs
  normally, can't change the draft, and gets the reminder line; the essay route still wins; cancel; expiry line
  and restore; card replacement; status lines; the draft survives `nextState`, `stateSchema` and a failed save.
- Pinned student: an activity op for a second student while a draft is open is refused, files nothing, and
  merges nothing.
- Cards: confirm with a `rows` selection saves only those rows; confirm without one saves all; a refused row
  doesn't stop the others; Undo removes exactly the saved rows; the flag rule in 4.11.
- The 18 conversations below with scripted model turns, to test the plumbing.

**Layer 2: the real model, on demand and on releases** *(Elvin's decision)*. Run before merging any PR that
touches `src/lib/axis/`, by someone clicking Run.
- New workflow `axis-eval.yml`: `workflow_dispatch` plus `release: published`. Same local Supabase setup as the
  CI integration job, seeded with made-up fixture students only. Never real data.
- Its own API key, `AXIS_EVAL_ANTHROPIC_API_KEY`, from a separate Console workspace with a spend limit (section 5).
  Note: prompt caches are per workspace, so eval runs won't warm or read production's cache.
- Each conversation is scored in code, not by a model: the sheet rows at the end equal the expected rows field
  by field; no extra rows; no counselor-visible text contains raw error text ("Invalid input", "Expected",
  zod paths); the number of AxIS questions is at or under the case's limit; draft state at the end is as expected.
- Pass bar: all 18 pass (over Elvin's 10–15: the resume, unrelated-message and switch-student cases came with
  his later decisions). A failed case is rerun twice and must pass 2 of 3, and any flaky case is reported as such.
  *(My call.)*

**The conversations (fixture student "Student A"):**

| # | Case | Expected |
|---|------|----------|
| 1 | Everything in one message | 1 card, all fields, no questions |
| 2 | "Add an activity for Student A" → AxIS asks → details with no verb, in the transcript's format | card with all fields after the 2nd message |
| 3 | "sophomore" | grades ["10"] |
| 4 | "grades 10–12" | ["10","11","12"] |
| 5 | Description given in the message | saved exactly as typed |
| 6 | After the card is filed: "write a description for it" | refused by the essay route; the draft and its card are unchanged; no description saved. (One-message mix, "add Code Club … and write a description", goes to the Clerk; the substring rule blocks any description it writes.) |
| 7 | "actually 8 hours" before Confirm | old card replaced, new card 8 |
| 8 | Rename after saving | update card on that row |
| 9 | "never mind" mid-draft | no rows, draft closed |
| 10 | Two activities in one go | 1 card with 2 rows, both checked |
| 11 | "It ran at City Library" (venue) | organization stays "Code Club"; no invented position |
| 12 | Mid-draft: "what's her GPA?", then "continue", then the missing hours | GPA answered normally, then "You still have an activity draft for Student A. Continue or cancel?"; draft unchanged by the question; "continue" shows what's missing; the hours complete the card |
| 13 | Reply after 30 minutes | expiry line; "yes" restores the fields |
| 14 | "200 hours a week" | plain "couldn't save" line, no raw error |
| 15 | The redacted transcript replayed | Code Club saved once, correctly; no City Library row; ≤3 counselor messages after the details |
| 16 | "Add the activities from her resume" (fixture resume as a Meridies document) | one card, a row per activity; each value labelled with its source; descriptions are exact copies labelled "from resume"; nothing not in the resume; card reason `outside-content` |
| 17 | Mid-draft: "Is her SAT 1450 good for UCLA?" | answered normally with the reminder line; no draft value changes (1450 is not hours or a grade) |
| 18 | Draft for Student A open; "add Debate Club for Student B, 5 hrs a week"; then "yes" | no card for Student B and nothing added to A's draft from that message; the switch question; after yes, A's draft cancelled (its card dismissed) and a draft for B holds Debate Club; Student A's sheet unchanged |

### 4.11 Security: Confirm all and the outside-content flag

Checked against the security session's design (`2026-10-30-axis-security-hardening-design.md`, in progress in
another worktree). Its rules that touch these cards: **"Confirm all" skips any card whose `reason` is
`outside-content`** (and destructive ops and sends), so those are confirmed one by one; and a chat stays flagged
while flagged text is in reach (its section 3).

**The gap, and the fix here.** Today `ops/run.ts` sets `reason: "outside-content"` only when it turns an *instant*
change into a card. Activity ops are now cards by default, so the reason would stay null even in a turn that read
a resume, and Confirm all would sweep a document-sourced card in. So an activity card gets `reason:
"outside-content"`:
- when its turn is flagged (by whatever rule the security design ends with), or
- when **any value or description on it came from an attached file or a student document**, judged from the
  per-value sources (4.5), not from the turn. A resume read in turn 1 still flags the card filed in turn 3, after
  the turn flag has cleared.
- Values only from typed messages and the counselor's meeting notes don't flag the card.

Tests: a layer 1 test for both triggers, and eval case 16 checks the reason.

**For the security session** (Elvin to pass on): the same gap applies to every op that is `confirm` by nature,
not only activities. Its Confirm-all rule relies on `reason`, so it should set `outside-content` on every card
filed in a flagged turn.

**One eval runner, not two.** Both designs propose `evals/axis/` and `npm run eval:axis`. Whichever PR lands first
creates it, and the other adds its cases. The workflow and capped key in 4.10 serve both. The security cases keep
their own pass rule (all 3 runs must pass, code guarantees only); the activity cases keep 4.10's.

## 5. Rollout and steps for Elvin

**Order** *(Elvin's decision, same as before):* database change to production → backend PR → bcha's app PR.

1. **Migration** (`ai_conversations.draft_rows`): safe to apply before the code, nothing reads it yet. Elvin
   pushes it from plain Terminal on main, dry-run first, as usual.
2. **Backend PR** (Elvin merges): drafts, normalizers, provenance, descriptions, cards, status lines, logging, evals.
   Works with or without the app's Save & edit button.
3. **App PR** (bcha reviews and merges): the activity card's checkbox rows (sending the checked `rows` on Confirm),
   the Save & edit button, live `dismissed`/`replaced` card updates, and the per-value source labels.

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
normalizers before validation; field-level messages to the model and plain lines to the counselor; descriptions
only as exact, code-checked copies of the counselor's messages or the student's own documents (labelled "from
resume"); confirm cards for adds and edits; one card per draft with a checkbox row per activity; a button that
saves and opens the sheet to edit (not a form); the provenance check, with typed messages, attached files,
meeting notes and the student's documents counting as sources; unrelated messages answered normally, never
captured, followed by the "Continue or cancel?" line; drafts pinned to their student, with AxIS asking before a
switch; Confirm all and the flag rule applying to document-sourced cards; the eval set, run on demand and on
releases with its own capped key and fixture students only; logging of category and path with no text; the merge
order.

**Mine (check these while reading):** the op call opens the draft (4.1); the sorter rule for draft vs unrelated
messages; activity ops refused in an unrelated turn; the 30-minute clock restarts on every message; cancel
dismisses pending cards; no expiry line when only cards are left; asking once and filing with blanks; restoring
fields on "yes" after expiry; saving the draft before `done`; all rows in the new column, up to 10; unchecked rows
dropped; edits as their own cards; the normalizer phrasings, range midpoint, "all year" = 52 and the category
mapping to the Common App list; description sources limited to `resume` and `activity-list` documents, whitespace
collapse only, chat attachments not counting; the 150-character note; UC descriptions stay blocked; status lines
written by code, with the prompt rule scoped to activity ops; the stale-card gap until the app PR; eval case 6 as a
follow-up; skipping college evidence while drafting; the extra log fields; one shared eval runner; the eval pass
bar; the $20 cap.

## 7. Open questions

None. The reviewer's two questions for Elvin are answered in 4.5 (sources) and 4.6 (Save & edit).

## 8. Prior art to reuse

- **Profile Update** (`lib/profileUpdates.ts`, the student's own AxIS) is a pattern to read, not code to reuse
  as is. Its `Draft` uses camelCase names, a Common App category enum and shorter caps (position 50, organization
  100). Its `missingFields` requires category and description, and `capDescription` cuts descriptions to 150
  characters, which conflicts with 4.4. Borrow the merge approach and `currentGrade` where they fit.
- **Confirm cards** (`ops/run.ts`, `axis_actions`, `POST /axis/actions/:id/confirm|dismiss|undo`) and the
  card UI (meridies-app `components/assistant/AxisAnswer.tsx`) exist and are reused as they are.
- **Other guards stay in force:** `dispatch.ts`'s prose-key check (essay paths only; `description` isn't a prose
  key) and `proseRefusal` on every string a write files on a card. A description that passes the substring rule
  still has to pass `proseRefusal`.

## 9. Left to the builder

Names of new helpers and the column; where the normalizers live (suggest `lib/axis/ops/normalize.ts`); the exact
draft-block wording; the cancel and yes word lists; how a draft row key is passed to the op (suggest an optional
`draft_row` input); unit test layout; the eval runner script (`npm run eval:axis`).
