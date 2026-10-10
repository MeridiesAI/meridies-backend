> **Summary of the full spec (`2026-10-09-import-pipeline-design.md`). If they
> disagree, the full spec wins.**

# Import Pipeline — Plain-English Version (Oct 9 2026)

## What we're building
Counselors upload a spreadsheet (CSV or Excel) of student info: GPAs, test
scores, courses, activities. Meridies:
1. figures out which of the counselor's students each row belongs to,
2. shows exactly what would change ("Maya's GPA: 3.5 → 3.8"),
3. saves the approved changes all at once,
4. lets the counselor undo the whole import for 30 days.

Students not on the roster get an invitation. Their data waits until they join,
and then the counselor approves it.

This also fixes today's bug: roster imports throw away GPA, test scores and the
other info in the file.

## Who it's for first
Independent counselors who work with families. Schools come later, after legal
paperwork.

## What ships when
- **Version 1.0:** the bug fix, plus CSV and Excel uploads. For Google Sheets,
  download as CSV and upload it.
- **Version 1.1:** PDFs (transcripts, score reports), switched on for a few
  test counselors first.
- **Later:** a direct Google Sheets connection, shared starter templates for
  common tools, schools, importing contacts, exporting spreadsheets.

## How we'll know it works
- Up to 5,000 rows per import: check once, save once, and nothing a student
  typed is overwritten unless the counselor says so.
- Next month's re-import only asks about what actually changed.
- Undo reverts everything nobody has edited since; anything that was edited is
  kept and listed.
- No student's data can end up on someone else's account.

## Matching students to rows
- We only look at **the counselor's own students**, never all of Meridies, so
  nobody can upload a list of emails to find out who has an account.
- **Same email and same name** → it's that student. Several rows for one
  student is normal, for example one row per test.
- **Email matches but the name doesn't** → the counselor must confirm
  ("email matches Jane Doe, file says John Doe").
- **One email shared by different names** (like twins using a parent's email)
  → a suggestion; never matched automatically.
- **No email match** → we suggest matches by name + birthday + school (or
  name + graduation year + school). The counselor confirms, and obvious
  matches can be confirmed all at once.
- **How names are compared:**
  - Capitals and accents are ignored (José = Jose).
  - Hyphenated last names match either part (García-López = López).
  - Common nicknames count (Robert = Bob) and so do preferred names.
  - First and last names must both match; initials alone never match, so twins
    stay apart.

## Students who aren't on the roster yet
- **Has an email** → invited. Their data waits until the invitation expires
  (14 days).
- **No email** → skipped, with a reason.
- **When they join**, nothing attaches automatically. The counselor sees "Jane
  accepted — apply her imported data?" If the name doesn't match, there's a big
  warning and the counselor types the name to confirm. The data expires 30 days
  after they join, with a warning email a week before.
- Invitations from the **old** roster import still land in this same list, so
  nothing gets lost during the switch.

## When the spreadsheet disagrees with the profile
- Empty fields are filled in.
- If the old value came from the same system's last import and nobody has
  touched it since, the new value is pre-selected.
- Anything a person typed is kept unless the counselor chooses to replace it.
- Similar changes are grouped ("GPA differs for 31 students: accept all / keep
  all / review each"), riskiest first.

## Who can see imports
- The counselor who ran the import, **plus the firm's owners and admins**.
  Admins can also undo an import and apply its waiting data.
- A solo counselor's imports are only theirs.
- What happens to a departing counselor's students (hand them all to one
  person, split them, cover temporarily) gets **its own design next**. Imports
  follow the students.

## GPAs
- We store exactly what the file says (for example 92 on a 100-point scale),
  plus the scale and whether it's weighted. **Never converted.**
- The GPA column gets bigger so it can hold 100-point scales.
- Step 1 checks every screen and feature that uses GPA (sorting, charts, college
  fit, AI) so it reads the scale and shows it next to the number.

## How the data is organized
We use "sticky notes": every proposed change is one note ("Maya's GPA 3.5 →
3.8"). The review screen is the list of notes, saving applies the approved
ones, and undo reads them backwards.

The tables:
- **Imports:** each upload, with its status, the system it came from, the firm
  it belongs to, and who confirmed they had the family's permission.
- **Import files:** each uploaded file.
- **Templates:** remembered column layouts, so the same system's next file
  needs no AI.
- **Import items:** one per student in the file.
- **Import changes:** the notes.
- **Import fields:** the master list of what imports may change. Nothing else
  can even be saved.

**Duplicate rules:**

| Data | Already there if… |
|---|---|
| Test scores | Same test and date. With no date, same test and score. "Best" or superscore values go into the main profile, not the score list. |
| Courses | Same name and school year. With no year, it's a suggestion for the counselor. Grades are stored as given. |
| Activities | Same name; suggestions only. |

## Where files are stored
- A separate private storage area just for imports.
- Only the counselor can upload, into their own import folder, while it's a
  draft.
- Before the first upload, the counselor ticks **"I have permission from the
  student's family to upload this information"**.
- We check what a file really is from its contents, not from its label.
- The raw file is deleted after saving, or after 7 days if never saved.

## Step by step
1. **Upload:** up to 20 files and **5,000 rows in total**.
2. **Read the file safely:** in a sealed-off process with memory and time
   limits. We collect column stats and date hints (is it month/day or
   day/month?), and refuse sheets with student names as column headers.
3. **AI suggests the column mapping:** it sees only column names, stats and
   masked examples like "<email>", never real values. The counselor can change
   anything and save it as a template.
4. **Rows become notes:** plain code, no AI, and every value is checked.
5. **AI cleans messy cells:** sent in batches by column, with no names
   attached. Anything still invalid is fixed by hand.
6. **Match and review:** grouped and risk-sorted; the counselor confirms how
   many invitations to send.
7. **Save:**
   - It runs in the background, all-or-nothing.
   - All problems are listed together first.
   - Each value is only written if it hasn't changed since review.
   - Then invitations go out and the files are deleted.
8. **Waiting data:** moves to "Ready to apply" when the student joins.
9. **Undo (30 days):** reverts everything nobody has edited since, **including
   waiting data that was applied later**, and cancels unaccepted invitations.
10. **Cleanup after 30 days:**
    - We delete the old and new values but keep a **fingerprint** of each
      imported value, so next month's import can tell whether it changed.
    - Honest note: for things like GPA, a fingerprint can be turned back into
      the value. So we treat it as personal data, list it in the privacy
      policy, and delete it when the student deletes their account.
11. **PDFs (1.1):**
    - Up to 50 PDFs of 30 pages each.
    - Never-collected items are excluded (see below).
    - The actual page is shown next to the values.
    - PDFs get their own cost limit.

## Sensitive data
Imports can only write fields on our master list; everything else is ignored.
On top of that:

**Never stored or passed on:**
- Government ID numbers: SSN, driver's license, passport, state ID,
  immigration numbers
- Bank, account and card numbers; family income; tax figures
- Health: diagnoses, medications, special-education (IEP/504) plans,
  accommodations
- Discipline, suspensions, criminal records
- Free/reduced lunch and income-based fee waivers
- Religion, sexual orientation, race/ethnicity
- Passwords and security answers

**Allowed, but always reviewed before they change anything:**
- **High:** GPA, test scores, class rank
- **Medium:** birthday, home address, phone, gender, citizenship status,
  first-generation status

**Social Security numbers:**
- Always blocked in the 123-45-6789 format.
- A plain 9-digit number is blocked only if the column says SSN.
- Otherwise it's flagged, because schools often use 9-digit student IDs.

## Security
- **Encryption:** encrypted while traveling and while stored; not "end-to-end",
  because our server and the AI must read files. We say so honestly.
- **Save and undo:**
  - Only our server can run them, and they check twice that you're allowed.
  - They use fixed, pre-written database commands, so nothing in a spreadsheet
    can become a database command.
  - Double-clicks can't save twice.
- **A limited database login for saving:** the server connects with a login
  that can only run save, undo and apply. It never uses the master database
  password, and the server refuses to start if someone tries.
- **Spam limits on invitations:**
  - fixed email templates
  - a daily limit, halved for new accounts
  - a staff check (Elvin for now, within a business day) for a counselor's
    first import with over 50 invitations
  - automatic pause on high bounce or spam rates
- **Imported text is treated as data** by all our AI features, never as
  instructions.
- **The AI never sees** real spreadsheet values when mapping; it sees messy
  cells only in batches with no names; it sees whole PDFs (in 1.1), and we
  say so.
- **Anthropic zero data retention:** confirmed in writing before launch.

## How long we keep things

| What | How long |
|---|---|
| Raw files | Up to 7 days |
| Sample cells | Until saving |
| Detailed changes | 30 days, then fingerprints plus a summary with counts only |
| Waiting data | Until the invite expires, or 30 days after joining |
| Backups | Per our Supabase plan |

## When things go wrong
Every failure has a clear message and a next step:
- bad files are rejected by name
- if the AI fails or hits its $2 limit, the counselor finishes by hand
- if the AI service is down, the import pauses and resumes on its own
- a template that no longer fits asks to remap
- values changed since review are kept and listed
- a failed save changes nothing
- invitations can be retried without duplicates
- crashes rerun safely

## Testing
- every value check, the masking, date formats, the SSN rules and name matching
- shared parent emails and long-format files (many rows per student)
- monthly re-imports, even after cleanup
- thousands of random undo sequences
- a student's edit never being overwritten
- real files from **CollegePlannerPro, CounselMore, GradBetter and homemade
  spreadsheets first**, then school systems
- booby-trapped files
- who can see what (counselors, an admin, a solo counselor, a student)
- double-clicks
- a full 5,000-row save and undo using the limited login

## Privacy and legal (not legal advice)
**For counselors now:**
- a privacy policy listing our outside services (Anthropic, Supabase, Railway,
  Resend) and what each gets, our retention promises (fingerprints included),
  deletion, and breach notice
- the family-permission checkbox, with a matching line in our terms
- a lawyer checks whether state student-privacy laws apply even when we sell to
  families

**For schools later:** a signed student-privacy agreement under FERPA (the
federal student privacy law), plus state rules such as New York's and
California's.

## Rollout
- Switched on per practice: 5–10 test counselors, then everyone. PDFs get their
  own switch.
- There's an off-switch for the AI parts.
- We rehearse the database change on a copy first.
- The old import screen is removed once everyone has the new one.

## What we'll measure
- **Main signal:** how often people fix imported values within 7 days.
- Undo rate.
- Drop-off at each step, and time to a first successful import.
- How many rows match automatically, and how long confirming suggestions takes.
- How many cells need cleaning.
- Conflicts per student and values skipped because they'd changed.
- Expired waiting data.
- AI cost per import.
- Email bounce and spam rates.

## Before building
- **5 real anonymized files this week**, mostly from CollegePlannerPro,
  CounselMore, GradBetter and homemade spreadsheets.
- Supabase Pro with backups and the paid email plan (Elvin is handling these).
- Anthropic zero data retention, in writing.
- The limited database login set up on Railway.
- The privacy policy.

## Build order
1. Database setup, save, undo, the "Ready to apply" list, the limited login and
   the GPA check across the app. This includes the bug fix.
2. CSV/Excel upload, mapping, cleanup, matching and review.
3. The screens in the app.
4. PDFs (1.1).
