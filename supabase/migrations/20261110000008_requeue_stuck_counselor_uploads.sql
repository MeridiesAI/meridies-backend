-- Documents: queue text extraction, once, for counselor uploads that never got it.
--
-- Why. A counselor's upload on the Files page (POST /files/documents) is a confirmed type
-- (kind_confirmed defaults to true, 20261024000001), but the route never set
-- extraction_requested_at, so lib/documentExtraction.ts never read it: the row sat at
-- parse_status 'pending' with no text, and AxIS couldn't read it. The code in this PR queues
-- every new counselor upload the AI may read; this file queues the ones already stuck.
--
-- Which rows. Uploads (source 'upload') in the documents bucket, uploaded by a counselor, still
-- confirmed and allowed for AI, at 'pending' with no request marker: exactly what the fixed route
-- would have queued. A student's own upload is left alone (the route doesn't queue those either;
-- their counselor confirming the type does). Drive and OneDrive imports set the marker themselves.
--
-- What happens next. The extraction recovery that already runs every minute on every replica
-- picks up marked rows (100 a tick, two at a time) and re-checks each one before it reads: still
-- confirmed, still allowed for AI, its counselor still approved, a safe path in the documents
-- bucket. A row it can't read ends 'failed' or, for a file with no text, 'skipped'. Nothing here
-- reads text or calls a model; text extraction is local. A request still unread after 24 hours is
-- marked failed by the same recovery, so nothing can sit at "queued". A notice names how many rows
-- were queued.
--
-- The update runs as the migration role, so documents_guard_student_restricted (a user-session
-- check) lets it through; documents_set_updated_at moves updated_at, as any extraction write does.
--
-- Deploy order: either. Before this PR's code the running build's recovery already reads marked
-- rows the same way. Idempotent: a second run finds nothing left to queue. Not in REQUIRED_SCHEMA:
-- it adds no object.

do $$
declare
  queued integer;
begin
  update public.documents d
     set extraction_requested_at = now(),
         extraction_attempts = 0,
         extraction_lease_until = null
   where d.source = 'upload'
     and d.bucket = 'student-documents'
     and d.parse_status = 'pending'
     and d.extraction_requested_at is null
     and d.kind_confirmed = true
     and d.available_to_llm = true
     and exists (
           select 1 from public.profiles p
            where p.id = coalesce(d.uploaded_by, d.owner_id)
              and p.role = 'counselor');
  get diagnostics queued = row_count;
  raise notice 'documents: queued text extraction for % counselor upload(s) left at pending with no request', queued;
end
$$;
