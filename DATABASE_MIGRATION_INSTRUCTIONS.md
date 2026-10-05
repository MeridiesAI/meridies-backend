# Database migration instructions: Demo v10 sync

These steps bring the Supabase project `kerstlpuvpmstiavxblv` up to the schema the v10 backend and app
expect. They were not applied automatically: the project is not reachable from the session that wrote
this change.

**Run them as soon as the PRs merge.** Railway and Vercel deploy `main` on merge, and until these
migrations are applied, routes that read the new columns fail. That includes existing screens: meetings
(`meeting_attendees`), AxIS chats (`ai_messages.trace`), Files (`folders.system_key`), invitations
(new `invitations` columns) and Financial aid (the FAFSA columns change).

Every file below was applied, in order, on a local Postgres with Supabase's auth/storage stubs and
then exercised through PostgREST and GoTrue with counselor, firm-colleague, student and outsider
accounts.

---

## 1. Take a backup

Supabase dashboard > Project `kerstlpuvpmstiavxblv` > Database > Backups. Confirm a recent backup
exists, or download one. Step 2's file `20261005030002` deletes data on purpose (see "Data that is
deleted" below), so a backup is the only way back.

## 2. Check where the database is today

In the SQL editor:

```sql
select version from supabase_migrations.schema_migrations order by version desc limit 3;
```

The newest version should be `20260923000005`. If you have been pasting migrations into the SQL
editor by hand, this table may be empty or behind; in that case check that
`public.student_red_flags` (the view from `20260923000005`) exists and continue.

## 3. Apply the 23 new migrations, in this order

Option A, Supabase CLI (records each version, recommended):

```bash
cd meridies-backend
supabase link --project-ref kerstlpuvpmstiavxblv
supabase db push        # shows the 23 pending files; confirm
```

Option B, SQL editor: open each file below from `supabase/migrations/`, paste it whole and run it,
one at a time, in this order. Stop at the first error and send it over.

| # | File | What it does |
|---|---|---|
| 1 | `20261005010001_overview_work_items_and_pins.sql` | My Work Queue items, pinned students per consultant |
| 2 | `20261005010002_overview_invitation_intake_and_referrals.sql` | New student fields on `invitations`, `accept_invitation()` re-created, `referrals` |
| 3 | `20261005010003_overview_outcomes_and_alumni.sql` | Admission outcomes, alumni records, cycles, `close_admission_cycle()` |
| 4 | `20261005010004_overview_ai_module_mass_invite.sql` | Allows the `mass-invite` AI audit label |
| 5 | `20261005020001_student_application_college_list.sql` | College list board columns, SCEA, statuses renamed (data migrated), supplement prompt catalog, recommendations |
| 6 | `20261005020002_student_application_sheets.sql` | UC fields on activities and honors; blank rows allowed |
| 7 | `20261005020003_student_application_essays.sql` | Essays linked to schools, prompts, documents and Google Docs; word count computed by the database (existing rows recounted) |
| 8 | `20261005020004_student_application_coherence_and_activities.sql` | Coherence reports, Activities Build program fields |
| 9 | `20261005030001_student_page_profile_and_polygon.sql` | Student personal details, hidden polygon axes, 10-axis cap |
| 10 | `20261005030002_financial_aid_fafsa_and_scholarship_matching.sql` | FAFSA narrowed to status and due date (v8 rule), family financials, scholarship matching, 6 scholarships seeded |
| 11 | `20261005030003_student_communication.sql` | Composer preferences, `student_messages` |
| 12 | `20261005040001_college_profile_v10.sql` | College profile facts, admitted profile, Common Data Set editions, programs |
| 13 | `20261005040002_college_webinar_tips.sql` | Supplemental advice from webinars (starts empty) |
| 14 | `20261005040003_events_hub.sql` | Events Hub listings and saves (starts empty); allows the `college-research` AI label |
| 15 | `20261005040004_seed_college_v10.sql` | Catalog seed for the profiled schools and the Build College Lists schools (generated, idempotent) |
| 16 | `20261005050001_contact_pipeline.sql` | Contact Pipeline stages and contacts |
| 17 | `20261005050002_pipeline_payments.sql` | Payment Tracker packages, invoices, payments (cents; balances derived) |
| 18 | `20261005050003_management.sql` | Consultant tasks with subtasks, consultant summaries, staff email blasts |
| 19 | `20261005050004_email_templates.sql` | Per-consultant email templates; allows the `email-template` AI label |
| 20 | `20261005060001_calendar_event_types_and_practice_events.sql` | Calendar event types, type assignments, practice events |
| 21 | `20261005060002_meeting_attendees.sql` | Meetings with several students (existing meetings backfilled) |
| 22 | `20261005060003_practice_folders.sql` | "Practice templates" and "Policy & research" folders (backfilled per counselor) |
| 23 | `20261005060004_axis_message_trace.sql` | AxIS chats keep their reasoning steps and sources |

Every new table ships with RLS enabled and its policies in the same file.

### Data that is deleted

`20261005030002` applies the v5 privacy rule that the v8 brief kept: the FAFSA shows its status and
due date only. It:

- drops `student_aid_profiles.fafsa_submitted_at` and `student_aid_profiles.efc_estimate`;
- deletes every `student_aid_checklist` row whose item is `fafsa`;
- maps old FAFSA statuses onto three (`verified` becomes `submitted`, `corrections-needed` becomes
  `in-progress`, `not-applicable` becomes `not-started`).

### Data that is changed in place

- `20261005020001`: `student_colleges.status` `considering` becomes `not-started` and `applying`
  becomes `in-progress`. If a student had the same college twice, the rows collapse onto the oldest
  one before the new unique index is created.
- `20261005020003`: every existing essay's word count is recomputed from its text.
- `20261005030001`: existing students keep their current polygon axes; only students with no axes get
  the new default five.

## 4. Check it worked

```sql
select version from supabase_migrations.schema_migrations
 where version like '20261005%' order by version;            -- 23 rows (CLI path only)

select count(*) from pg_tables
 where schemaname = 'public' and rowsecurity = false;        -- expect 0
```

Then Supabase dashboard > Advisors > Security: there should be no new "RLS disabled" or
"policy missing" warnings.

## 5. Settings outside the database

1. **Google consent screen.** Google Cloud Console > APIs & Services > OAuth consent screen > Scopes:
   add `https://www.googleapis.com/auth/drive.file`. Counselors who already connected Google need to
   disconnect and connect again once. Until they do, "Add essay" on the Application page explains
   the missing permission and files the prompts as plain records.
2. **Railway cron for scheduled messages.** Add a second cron next to the accountability sweep,
   every 5 to 15 minutes:

   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
     "https://<api-host>/communication/internal/dispatch"
   ```

   Without it, "Schedule send" and messages held for quiet hours stay scheduled and never go out.
   It needs `CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY`, which the sweep already uses.
3. **No new environment variables** and no new storage buckets.

## 6. If something fails

A failure leaves the earlier files applied and stops there. Send the file name and the error text.
Files 4, 14 and 19 rebuild the `ai_runs` module check by reading the current list back and adding
their label, so running any of them a second time is harmless.
