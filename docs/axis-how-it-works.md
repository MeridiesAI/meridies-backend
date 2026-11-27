# How AxIS works today

What the AxIS code on `main` does, stage by stage, as of commit `b9611ea` (2026-11-22). It describes the code, not
the plan. The design doc is [`docs/axis/AXIS_SYSTEM.md`](axis/AXIS_SYSTEM.md); where the code does something
different, this doc says so in a **Design mismatch** note, and the [last section](#where-the-code-and-the-design-doc-disagree)
lists every mismatch in one table.

Nothing here was checked against production (which migrations are applied, what the app renders). Where behaviour
depends on a migration, both cases are described.

## The short version

A counselor's message goes to `POST /axis/conversations/:id/messages`. The server then:

1. loads everything the turn may need at once (roster, college index, student record, chat history, files);
2. works out what the message is about **in code, with no model** (the classifier);
3. answers simple lookups straight from the database, **with no model** (the fast path);
4. otherwise gathers evidence in parallel, then runs one streamed Claude Haiku 5.5 conversation with tools (the tool
   loop), sometimes preceded by parallel "specialists";
5. checks every number in the answer against what it read, while the answer streams (the number check), and sends
   only the doubtful sentences to a second model call after the answer is done;
6. can change things in Meridies (actions): some changes run at once with an Undo, the rest wait for the counselor's
   Confirm;
7. logs one audit row per model run, one log line per turn, and every action it took or proposed.

## Read this first: document, email and Drive search are switched off

AxIS was built with two plug-in points ("ports") in `src/lib/axis/ports.ts`: `RetrievalPort` (search inside uploaded
files) and `ConnectorPort` (search Gmail/Outlook and Drive/OneDrive). **Nothing in `src/` registers either one.**
`registerRetrieval` and `registerConnectors` are called only in `test/unit/axis-engine.test.ts`. So in production
the empty default ports answer every call:

- `retrievalReady()` is false and `connected()` returns no providers.
- The tools `search_documents`, `read_document`, `search_email` and `search_connected_files` are never offered to
  the model (`toolList`, `src/lib/axis/tools.ts:535`).
- The speculative search at the start of a turn, the fused document search, the email search and the Drive/OneDrive
  search in the evidence planner never run.
- The retrieval fusion code (`src/lib/axis/retrieval.ts`: reciprocal rank fusion, near-duplicate removal, MMR) is
  built and unit-tested but never called with real data.

AxIS still sees file content two other ways: the student record's `documents` section (the context layer,
`src/lib/context/`), and files the counselor attaches to the chat (`src/lib/axis/attachments.ts`). The Google and
Microsoft connectors that exist elsewhere in the backend (Drive picker, Calendar) are not wired into AxIS.

> **Design mismatch.** The design doc describes document search, email search, retrieval fusion and the speculative
> search as part of every turn (sections 1, 2, 3.3, 3.4). Its intro and rollout step 5 say they wait on the two
> ports. They still do: the code is there, switched off.

---

## Stage 0. Routes and the turn's outer shell

**Files:** `src/routes/axis.ts`, `src/lib/axis/failsafe.ts`, `src/lib/axis/llm.ts` (`reserveTurn`), mounted at
`/axis` in `src/app.ts:239`.

| Route | What it does |
|---|---|
| `POST /axis/conversations/:id/messages` | One turn, streamed as Server-Sent Events. Counselor only, 20 a minute. Body: `content` (1 to 8,000 characters), optional `studentId`, optional `attachmentIds` (up to 5). |
| `POST /axis/warm` | Writes the prompt cache before the first question. At most once per counselor and student per 4 minutes. Always answers 202. |
| `GET /axis/actions` | Pending proposals, or with `status=all&conversationId=` every card in a chat. |
| `POST /axis/actions/:id/confirm` | Runs a waiting change, or returns an email draft for the composer. |
| `POST /axis/actions/:id/dismiss` | Dismisses a waiting card. |
| `POST /axis/actions/:id/undo` | Reverses a change that went through (or restores a delete from the trash). |
| `/axis/eval/*` | Only when the eval clock is on (local stack), `src/routes/axisEval.ts`. |

Listing, creating, renaming and deleting chats stay on `/chat/conversations` (`src/routes/chat.ts`).

**Before the stream opens** (`src/routes/axis.ts:91-129`), anything that can fail fails as plain JSON:

- the chat must exist and the counselor must be able to view its student (`resolveStudentId`);
- readiness: with no `ANTHROPIC_API_KEY`, or migration `20261018000001` not applied, the route answers
  `503 { code: "axis_unavailable" }` without saving anything, and the app can resend to `/chat` (`axisReadiness`,
  `failsafe.ts:101`; a missing schema is re-probed every 30 seconds, a ready one is remembered);
- the turn's first model call is reserved against the counselor's AI budget (`reserveTurn`), so a spent quota is a
  plain 429;
- the counselor's message is saved, attached files are claimed, the chat is tagged `axis`.

**The stream** (`runSseTurn`, `failsafe.ts:159`): a 90-second wall clock over the whole turn, a ping every 15
seconds, the counselor closing the panel aborts the model and the tools, and any failure before `done` ends with one
`error` event whose text is ours, never an SDK's or Postgres's.

Design doc: matches section 6.

## Stage 1. Load everything at once

**Files:** `src/lib/axis/engine.ts:286-317`, `src/lib/axis/data.ts`, `src/lib/axis/entities.ts`,
`src/lib/axis/memory.ts`, `src/lib/axis/attachments.ts`, `src/lib/axis/cache.ts`.

In parallel:

| What | Cached in-process for |
|---|---|
| The counselor's roster (`loadRoster`) | 60 seconds |
| The college catalog index (`loadCollegeIndex`) | 6 hours |
| The student's record, or the roster view in a roster chat (`cachedStudentContext`, `buildRosterContext`) | 60 seconds |
| Chat history, summary and dialogue state (`loadHistory`) | not cached |
| Connected apps (`getConnectors().connected`) | always empty today |
| The chat's attached files (`fileBlocks`) | not cached |
| The chat student's key facts (`studentFacts`), for the fast path | not cached |
| What AxIS did or proposed earlier in this chat (`recentActionsText`, `ops/run.ts:608`) | not cached |

A message that reads like a change request (`looksLikeChange`, `engine.ts:173`) loads a narrower record: only the
sections the counselor wrote (`RECORD_FOR_CHANGES`), so text a student or a file wrote can't steer a change.

Caches are per server process and cleared on deploy, so a counselor's edit can take up to a minute to show in a chat
that already read the record.

## Stage 2. The classifier ("understanding")

**Files:** `src/lib/axis/nlu.ts`, `src/lib/axis/lexicon.ts`, `src/lib/axis/entities.ts`, `src/lib/axis/dates.ts`,
`src/lib/axis/text.ts`. Called at `engine.ts:322`. No model call.

- **Intent.** Nine intents: `record`, `documents`, `email`, `roster`, `colleges`, `strategy`, `action`, `essay`,
  `chitchat`. Each has weighted word patterns; a message scores the sum of the weights that match (`scoreIntents`).
- **Adjustments** (`adjust`, `nlu.ts:102`): a named school adds to `colleges`; a student in view or named lowers
  `roster`; with nobody in view, `record` points fold into `roster`.
- **Questions don't order changes** (`dampQuestions`, `nlu.ts:129`): a message that is a question, and not phrased as
  a request ("can you…", "please…"), has its `action` score capped at 2.
- **Ties** (`resolveTies`): `strategy` wins when within 1 point of the top; `action` at 5 or more wins; `essay` at 6
  or more wins.
- **Fallback:** no score at all means `record` with a student in view, else `roster`. Confidence is
  (top − second) / top.
- **Clauses:** the message is split into parts and each part gets its own intent.
- **Entities:** students matched against the roster (exact, first+last, unique first or last name, close spelling;
  shared first names reported as ambiguous), schools against the catalog index. Pronouns ("her", "that school") pick
  up the last turn's student or school if it was under 30 minutes ago.
- **Also extracted:** the attribute asked about (GPA, admit rate, deadline…), a date window, the sentence form
  (lookup, yes/no, imperative, statement), judgement words, search keywords with counselor shorthand expanded, and a
  complexity score used later for effort.

Design doc: matches section 3.1. Its accuracy figures (87-89% on held-out sets) were not re-measured for this doc.

## Stage 3. The activity draft check

**Files:** `src/lib/axis/drafts/turn.ts`, `drafts/sorter.ts`, `drafts/state.ts`, `drafts/write.ts`,
`drafts/lines.ts`. Called at `engine.ts:339`.

If the chat has an open activity draft (activities the counselor is adding through AxIS), the message is sorted:

- **cancel** or **continue**: answered by code with no model call (`engine.ts:385-400`);
- **draft**: goes to the Clerk with the draft attached, skipping the fast path;
- **unrelated**: answered normally, followed by a reminder line about the open draft.

A draft with no counselor message for 30 minutes expires. Activity writes (`application.add_activity`,
`add_activities`, `update_activity`) are merged into the draft rather than filed straight to a card.

> **Design mismatch.** Not in `AXIS_SYSTEM.md`. Its design is
> `docs/superpowers/specs/2026-10-30-axis-activity-drafts-design.md`.

## Stage 4. The fast path (direct answers, no model)

**Files:** `src/lib/axis/compiler.ts`, `src/lib/axis/data.ts`, `src/lib/axis/risk.ts`. Called at
`engine.ts:402-437`.

Tried only when: the message is one clause; its intent isn't essay, action or chitchat; it brought no new files; and
it isn't continuing an activity draft. `compileDirect` (`compiler.ts:100`) then tries five frames, in this order:

| Frame | Example | Built from |
|---|---|---|
| Caseload risk | "Who's behind this week?" | `loadRosterRisk` (below), top 5 with reasons |
| Roster count | "How many students do I have?" | the roster |
| School figures | "Cornell's admit rate", "SAT range at MIT and UCLA" | College Scorecard rows, up to 4 schools, with data year and an `[S#]` citation; a note when not re-verified in a year |
| What is due | "What's due this week?", "her next deadline" | deadlines, open tasks, meetings; 14 days if no window was given |
| A student's facts | "Ethan's GPA", "her SAT", "intended major" | GPA, SAT, ACT, rank, majors, class year, high school |

Anything less certain returns nothing and the turn moves on: an ambiguous student or school, a school matched with
low confidence, a time phrase the date parser couldn't read ("before Thanksgiving"), a judgement word, or a
non-lookup sentence form.

A direct answer is sent as one `delta` event, with `route.path = "direct"`. There is no number check (the figures are
the database's) and no `ai_runs` row.

**The caseload ranking** (`risk.ts`), shared by the fast path, the planner and the `rank_caseload` tool:

- overdue: 3, plus up to 2 more as it ages (capped at 14 days late);
- due within the window: (1 − days left / (window + 1)) × 2 × a status weight (not started 1, stalled 1.2, in
  progress 0.6, in review 0.3, deadline 0.8);
- a task with no activity past the counselor's stall threshold (or never started) is multiplied by
  1 + (days idle, up to 21) / 21;
- a student's score is their worst item + 0.6 × the second + 0.3 × the third + 1.5 per open red flag.

> **Design mismatch.** Section 3.2 says a judgement word always keeps a question off the fast path. The code checks
> caseload risk *before* the judgement-word test (`compiler.ts:105-109`), so "who should I worry about?" is still
> answered directly. Section 3.5's formulas differ slightly: the window is divided by (window + 1), and the stall
> multiplier counts all idle days, not only days past the threshold. Section 3.2 doesn't mention that new files or
> an open draft skip the fast path (both features came later).

## Stage 5. The essay path

**Files:** `src/lib/axis/engine.ts:227-251` (`essayAdvice`), `:439-468`; `src/lib/anthropic.ts`
(`enforceNoProse`, `NO_PROSE_SYSTEM`).

An `essay` intent never reaches the tool loop. One structured Haiku call (low effort, `ai_runs` module
`essay-advice`) returns 2 to 8 bullets of advice; code then drops anything that reads like prose. If nothing
survives, a fixed bullet says AxIS doesn't write essay text.

Design doc: matches.

## Stage 6. Evidence gathering (the planner)

**Files:** `src/lib/axis/planner.ts`; called at `engine.ts:479`.

Before the model runs, the planner predicts what the answer needs and fetches it in parallel, each step with
**2.5 seconds** (`STEP_TIMEOUT_MS`). A step that times out or fails is skipped and named to the model ("Not gathered
in time, use a tool if you need it").

Steps that run today:

| Step | When |
|---|---|
| Another student's record (up to 2) | The question names them. A change request reads only the counselor-written sections. |
| What is due (default: next 3 weeks) | The intents include roster, record, strategy or action, and the question has a date window or a time word |
| Caseload ranking (top 8) | Roster intent, no student in view or named |
| Named schools' figures (up to 4), as citable `[S#]` passages | A school is named |

Steps that exist but never run today (see "switched off" above): the fused document search, the email search and
the Drive/OneDrive search.

The result goes into the user turn: numbered passages first ("cite as [S#]"), then the computed blocks. Text a
student or family wrote is wrapped in untrusted-data markers, and the planner records whether it showed any such
text, which later decides whether changes wait for Confirm (stage 10).

> **Design mismatch.** Section 3.3 lists the document, email and Drive steps as part of the plan; they are inactive.

## Stage 7. Specialists and effort

**Files:** `src/lib/axis/profiles.ts`, `src/lib/axis/specialists.ts`; called at `engine.ts:472-474` and `:557-568`.

**Profiles.** The intent picks a profile (the Clerk when continuing an activity draft):

| Mode | Label | Effort | Max model calls | Number check after |
|---|---|---|---|---|
| record | Record analyst | low | 3 | yes |
| documents | Document researcher | medium | 4 | yes |
| email | Correspondence | low | 3 | yes |
| colleges | College data | low | 3 | yes |
| roster | Caseload | low | 3 | yes |
| strategy | Strategist | high | 5 | yes |
| action | Clerk | low | 6 | no |
| chitchat | AxIS | low | 1 | no |
| specialist | Specialist | low | 3 | no |
| synthesis | Synthesis | medium | 2 | yes |

Effort (`effortFor`, `profiles.ts:45`) goes up one level at complexity 3 and another at 5, and down from medium to
low for a one-part question the classifier was confident about (complexity 0, confidence 0.6 or more).

**Fan-out** (`specialistTasks`, `specialists.ts:46`) happens only when the message has 2 or 3 parts, all of them
research intents (documents, email, strategy, colleges, record), at least 2 different intents, and at least 2 of the
parts are documents or email parts the planner found no file or mail passages for. Then each part gets its own short
tool loop (3 calls, low effort, 15 seconds shared, research-only: a write tool answers "Specialists only research"),
the first starts alone and the rest wait up to 600 ms for it to start streaming (so they share its prompt cache),
and one streamed **synthesis** call writes the answer from their findings.

> **Design mismatch.** (1) Section 3.7 says specialists use the same effort as the main request; the code always
> runs them at low (`engine.ts:561`). (2) Section 13 says specialists can't run until the ports exist. By the
> code's own rule they can: without the ports a documents or email part is never "covered", so a question with two
> such parts fans out today, to specialists that have no document or email tools. I have not checked logs to see
> whether this has happened. (3) The step down from medium to low isn't in the design.

## Stage 8. The tool loop (the main answer)

**Files:** `src/lib/axis/engine.ts:570-628`, `src/lib/axis/loop.ts`, `src/lib/axis/tools.ts`,
`src/lib/axis/models.ts`, `src/lib/axis/llm.ts`, `src/lib/axis/ledger.ts`, `src/lib/proseGuard.ts`.

**The request** (`requestBase`, `engine.ts:148`; `systemBlocks`, `engine.ts:125`):

- model `claude-haiku-5-5` for every AxIS call, adaptive thinking (text not shown);
- top-level effort pinned at `high`, with the turn's real effort set by a per-message system message (beta
  `mid-conversation-output-config-2026-07-01`), so changing effort doesn't break the prompt cache;
- system prompt: the fixed AxIS rules and the whole action catalog (cached 1 hour, shared by every counselor), then
  today's date and the student record or roster view (cached 1 hour), then the chat's memory summary; everything
  after the two 1-hour marks is cached automatically for 5 minutes;
- messages: the earlier files' stored text, the chat history trimmed to about 90,000 tokens (estimated as
  characters / 3), the effort message, then the user turn (recent actions, gathered evidence, specialist findings,
  what wasn't gathered in time, the activity draft if any, the question, and this message's files), then a
  `Mode: <mode>.` system message;
- `max_tokens` 8,000 / 16,000 / 24,000 by effort.

**The loop** (`runLoop`, `loop.ts:178`):

- read-only tools start as soon as their input finishes streaming, while the model is still writing; writes start
  only after the model's turn ends;
- every tool call in a round runs at once and all results go back in one message;
- after 2 rounds that brought nothing new, the next call must answer (`tool_choice: none`); so must the last call
  under the profile's cap, and any call after the **40-second** tool-phase budget (`TURN_BUDGET_MS`);
- a refusal ends with "I can't help with that one."; running out of tokens ends with a "cut short" note; an answer
  that is only thinking is asked once for the text;
- if the API rejects the per-message effort or the mode message, the first call is retried once without them and
  both stay off for the process;
- a tool input that isn't valid JSON is asked for again, up to 2 times;
- every model call goes through the AI budget gate (reserve before, settle after).

**The tools** (`tools.ts`). Twelve are defined; eight are offered today because the ports are off:

| Tool | Offered today | Does |
|---|---|---|
| `find_student` | yes | Roster lookup by name |
| `get_student_record` | yes | Sections of a student's record |
| `list_upcoming` | yes | Deadlines, tasks and meetings in the next N days |
| `rank_caseload` | yes | The caseload ranking, over `days` ahead (1-60, default 14; "this week" = 7, as the fast path) |
| `search_colleges` | yes | Catalog search, returns `[S#]` passages |
| `lookup` | yes | Read operations from the action catalog (ids for changes) |
| `perform_action` | yes | Write operations from the action catalog (stage 10) |
| `propose_action` | yes | An email draft for the Communication composer |
| `search_documents`, `read_document` | no | Need the retrieval port |
| `search_email`, `search_connected_files` | no | Need the connector port |

Each read has 8 seconds and each write 20; a timeout or error comes back as a result the model can work with. Inputs
are checked with zod. The same read twice in a turn is answered from memory. Results are cut at 40,000 characters.
Every passage passes the AI guard (`guard.ts`: keep-out, waived letters, the practice's document switch, another
student's file) and gets a number in the ledger: 2,500 characters a passage, 30,000 a turn.

**While it streams:** the essay guard (`ProseGate`) withholds the rest of an answer that passes the first-person
cap. **After it streams:** citations are resolved against the ledger and any `[S#]` that points at nothing the model
was shown is removed before the answer is saved (`resolveCitations`, `dropInvalidCitations`).

> **Design mismatch.** Section 3.10 lists ten tools, without `lookup` and `perform_action` (section 14 adds them),
> and says each call has 8 seconds (writes have 20). The JSON retry isn't in the design.

## Stage 9. The number check

**Files:** `src/lib/axis/grounding.ts`, `src/lib/axis/text.ts` (`SentenceStream`), `src/lib/axis/verify.ts`;
wired at `engine.ts:487-493`, `:597`, `:625`, and `src/routes/axis.ts:186-199`.

**In code, while the answer streams.** Every number and calendar day in what the turn read is indexed: the record or
roster view, the planner's evidence and every ledger passage, the question, the attached files' text, the
counselor's earlier messages, and each tool result as it arrives. As each sentence of the answer completes, its
figures are pulled out (money, percentages, dates, score ranges, decimals, whole numbers of 100 or more, and smaller
numbers next to a score word like "ACT 34"; bare years and small counts are skipped) and each is marked:

- **found**: in the evidence at the precision written (3.874 supports "3.87"; 0.125 supports "12.5%");
- **derived**: the sum or difference of two found figures in the same sentence;
- **missing**: neither.

A cited sentence also gets a support score (the share of its content words found in the passages it cites; under
0.2 is a weak citation). Each sentence with figures or citations is sent as a `grounding` event as it streams.

**By model, after `done`.** If the profile checks numbers, the answer wasn't refused or cut by the essay guard, and
something wasn't confirmed, the flagged sentences (only those) go to Haiku at low effort with up to 60,000
characters of material (`adjudicate`, `ai_runs` module `axis-verify`). It rules each one supported,
general knowledge or unsupported. The result is sent as a `verification` event and saved on the answer. If every
sentence was confirmed in code, a `verification` with nothing unsupported is sent with no model call.

**Not checked:** fast-path and essay answers (no model wrote the figures, or there are none), Clerk and chitchat
turns, and any turn in a chat that has a PDF or image attached (the code can't read those back, so it skips the
check rather than flag every figure).

> **Design mismatch.** Section 3.8 doesn't mention that attached PDFs or images switch the check off (attachments
> came later). Otherwise it matches.

## Stage 10. Actions

**Files:** `src/lib/axis/tools.ts` (`propose_action`, `lookup`, `perform_action`), `src/lib/axis/ops/run.ts`,
`ops/dispatch.ts`, `ops/registry.ts`, `ops/types.ts`, `ops/trash.ts`, `ops/catalog/*.ts`,
`src/routes/axis.ts:236-415`.

**Email drafts** (`propose_action`). The model can only file an email draft (the schema's `type` enum and the input check both take only
`email_draft`; there is no due date). A `work_item` card filed before that still confirms (`routes/axis.ts`). It is saved as a pending `axis_actions` row and shown as a card. Confirm returns the subject and body
for the app's Communication composer; nothing is sent from AxIS. The draft's text is held to the essay guard.

**The operation catalog.** 248 operations in 41 groups (students, tasks, deadlines, college list, meetings,
pipeline, payments, management, settings and more), counted from `ops/registry.ts` at this commit:

- 57 reads, reached through `lookup`. Only GET requests may run as a lookup.
- 191 writes, reached through `perform_action`: 74 run at once, 98 always wait for Confirm, 19 depend on the input.
  129 of them define how to undo themselves.

**How a write runs** (`runWrite`, `ops/run.ts:388`). Every change is a request to this API's own routes, run
in-process with the counselor's own token (`dispatch`, `ops/dispatch.ts:129`), so the route's validation, rate
limits, approval gate, side effects and database row security all apply. A fixed list of paths is refused whatever
the catalog says (`NEVER`: `/axis`, `/chat`, `/auth`, `/me`, `/account`, `/internal`, `/webhooks`, `/imports`,
`/essays`, every route that runs a model, and others), and essay-like text is refused on any essay or supplement
path.

- **Runs at once:** the change is made, an `axis_actions` row records it as `executed` with its undo step, and the
  card shows Done with Undo.
- **Waits for Confirm:** a `pending` row and a card. Confirm re-checks everything at the click (the operation still
  exists, the stored input still validates, the counselor can still edit the student) and claims the row first so a
  double click can't run it twice.
- **An instant change becomes a card** when the turn (or the previous turn) read text someone other than the
  counselor wrote (a file, an email, the student's own words, a lookup marked outside), or after 5 instant changes in
  one turn. Once migration `20261108000004` is in, a narrower rule applies (only long free text counts, and short
  student-written fields hold back only changes a student or family would see; `COUNSELOR_ONLY`, `ops/run.ts:82`).
- **Limits:** 20 writes a turn; card lines are refused, never cut, when too long to show whole.
- **Deletes that wait for Confirm** (32 operations, `TRASH_COVERED`) keep their rows in a 30-day trash, and Undo
  restores them (needs migration `20261108000003`; without it these deletes don't run). A restored meeting re-sends
  its invitation.

Each later turn reads the last 12 actions in the chat and their status (`recentActionsText`), so AxIS knows what was
confirmed, dismissed or undone.

> **Design mismatch.** The design's intro and sections 3.10 and 3.11 say only `propose_action` writes and every
> proposal waits for the counselor. Section 14 corrects this, and the code follows section 14: most writes go through
> `perform_action`, and 74 kinds of change run at once with an Undo. The trash and restore come from
> `docs/superpowers/specs/2026-10-30-axis-security-hardening-design.md` and aren't in `AXIS_SYSTEM.md`.

## Stage 11. After the answer

**Files:** `src/routes/axis.ts:157-209`, `src/lib/axis/memory.ts`, `src/lib/axis/quotes.ts`,
`src/lib/axis/attachments.ts`.

In order, after the answer has streamed:

1. The answer is saved to `ai_messages` with its citations, tool trace, sources and `ai_run_id` (and, once
   `20261108000004` is in, the runs of 8 or more words it quoted from free text).
2. The action cards are linked to the saved answer, and `done` is sent: the counselor can type again.
3. The dialogue state (students and schools named, newest first; whether outside content was read; the activity
   draft) is saved, only if the chat hasn't been written since the turn read it.
4. The number check's model stage runs (stage 9).
5. When the stream has closed: if the chat has 20 or more unsummarized messages, everything but the newest 12 is
   folded into a summary of at most 4,000 characters (Haiku, low effort, `ai_runs` module `axis-memory`; quoted runs
   are replaced by "[quote from …]"). Then files attached this turn are read once and their text stored, so later
   turns send the text instead of the file.

Each turn replays the newest 12 messages verbatim, with old citation markers removed. Tool results are never stored.

Design doc: matches section 3.9. The quote check isn't in `AXIS_SYSTEM.md` (it's from the security hardening spec).

## Stage 12. Logging and cost

**Files:** `src/lib/axis/llm.ts` (`openRun`, `closeRun`, `usageColumns`), `src/lib/axis/engine.ts:370-374`
(`logTurn`), `src/lib/aiBudget.ts`, `scripts/axis/axis-cost-report.sql`.

| Where | What is recorded |
|---|---|
| `ai_runs`, module `axis` | One row per tool-loop or specialist turn. Input: intent, confidence, path, effort, evidence steps, skipped steps, file count. Output: stop reason, model calls, tools used, passages, citations kept and removed, sentences checked and unverified, writes and instant writes, whether outside content was read, whether the essay guard cut the answer, and tokens (cache reads and writes split by 5-minute and 1-hour, and calls past Haiku's 100K-token price line counted apart). Status `succeeded`, `blocked` or `failed`. |
| `ai_runs`, other modules | One row each for `essay-advice`, `axis-verify`, `axis-memory`, `axis-warm` and `axis-attachment` (file transcription). |
| No `ai_runs` row | Fast-path answers and code-written draft replies (no model call). |
| Server log, one `axis turn` line per turn | Path, intent, fast-path frame, draft state and outcome codes, model calls used and allowed, chat id, milliseconds. Never message text, values or names. Errors log only their class, code and status (`errInfo`). |
| `ai_messages` | The counselor's message; the answer with citations, trace, sources, run id, verification and quoted runs. |
| `axis_actions` | Every email draft and operation: pending, executed, confirmed, dismissed, failed or undone, with its result and undo step. |
| AI budget | Every model call reserves before and settles after with its real usage. |

`scripts/axis/axis-cost-report.sql` prices the `ai_runs` rows (cost per turn, cache hits, long prompts, pre-warm
cost). It is read-only and is run by hand.

Design doc: matches section 12 step 6.

---

## Where the code and the design doc disagree

| # | Design doc says | The code does | Where |
|---|---|---|---|
| 1 | Document search, email search, Drive/OneDrive search, retrieval fusion and the speculative search are part of each turn (§1, §2, §3.3, §3.4) | Built, but nothing registers the two ports, so none of it runs | `ports.ts`; no `registerRetrieval`/`registerConnectors` call in `src/` |
| 2 | Ten tools, each with 8 seconds (§3.10) | Twelve tools (adds `lookup`, `perform_action`, per §14); eight offered today; writes get 20 seconds | `tools.ts:93-94`, `:535` |
| 3 | Only `propose_action` writes; every proposal waits for Confirm (intro, §3.10, §3.11) | Superseded by §14: `lookup` and `perform_action` reach 248 catalog operations (191 writes); 74 kinds of change run at once with Undo | `ops/run.ts`, `ops/registry.ts` |
| 4 | A judgement word keeps a question off the fast path (§3.2) | Caseload-risk questions are answered directly even with one | `compiler.ts:105-109` |
| 5 | Specialists use the same effort as the main request (§3.7) | Always low | `engine.ts:561` |
| 6 | Specialists can't run until the ports exist (§13) | Their trigger counts documents/email parts as unanswered when the ports are off, so they can run today, without document or email tools | `specialists.ts:46-54`, `engine.ts:543-545` |
| 7 | Effort only goes up with complexity (§3.7) | Also steps down from medium to low for a simple, confidently classified question | `profiles.ts:49` |
| 8 | Caseload urgency formulas (§3.5) | Window divided by (window + 1); stall multiplier counts all idle days, not only days past the threshold | `risk.ts:55-74` |
| 9 | Not mentioned | The number check is skipped in any chat with a PDF or image attached | `engine.ts:315`, `:604`, `:659` |
| 10 | Not mentioned | Activity drafts: code-written replies, the Clerk path, 30-minute expiry | `drafts/*` |
| 11 | Not mentioned | Chat file attachments, read once and replayed as text | `attachments.ts` |
| 12 | Not mentioned | 30-day trash and Restore for confirmed deletes | `ops/trash.ts`, `routes/axis.ts:368-387` |
| 13 | Not mentioned | The free-text rule and quote check, switched on by migration `20261108000004` | `failsafe.ts:50`, `quotes.ts`, `ops/run.ts:82` |
| 14 | Not mentioned | Invalid tool-input JSON is asked for again, up to 2 times | `loop.ts:257-261` |

Items 10 to 13 have their own specs under `docs/superpowers/specs/`; they are missing from `AXIS_SYSTEM.md`, not
from the design work.

## What this doc did not check

- Production: which of `20261018000001`, `20261019000001`, `20261020000001`, `20261108000001`, `20261108000003`
  and `20261108000004` are applied, and so which branches above run there.
- The app: how `meridies-app` renders the events, cards and verification.
- Live behaviour: no turn was run for this doc. The one thing executed was a script that counted the operation
  catalog from `ops/registry.ts`.
