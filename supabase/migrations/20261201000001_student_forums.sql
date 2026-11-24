-- Student Forums: posts about colleges, each approved by the author's assigned counselor before other students read it.
--
--   * `forum_posts`  one post: the author (`student_id`), the college it is about, its kind (thought, video,
--     creator, food), a title (80), a body (600; a thought must have one), an https url (2,000; a video or creator
--     post must have one), the review state (pending, approved, rejected, reported) with the reviewer's note, who
--     reviewed or reported it and when, and the author's first name and class year as other students see them
--     (copied when written, so a post never reads the author's profile).
--
-- Read rule (RLS): the author reads their own posts in every state; any student reads an approved post, across
-- practices; the author's ASSIGNED counselor reads all of their posts: `profiles.counselor_id` is the viewer AND
-- the viewer is an approved counselor (`private.forum_is_assigned_counselor`). Deliberately not
-- `private.can_view_student` / `private.is_counselor_of`: those admit collaborators (and the student), and a
-- collaborator is not who approves a minor's post. Parents and pending counselors read nothing (approval gate).
-- Clients write NOTHING: every write (post, approve, reject, report) is the API's, with the service role, after
-- the caller's own RLS read, so a student can't approve their own post through PostgREST.
-- Clients read the listed columns only (a column grant, the same list as the API's FORUM_COLUMNS): `reported_by`
-- and `reviewed_by` (and `reviewed_at`) are service-role only, so a reported author can never learn who reported
-- them, nor any student who reviewed a post. `reported_by` stays on the row after a decision as the record of who
-- reported it. `student_id` is readable on an approved post (an opaque uuid the routes need for `mine`).
--
-- Deploy order: either. Without this file every `/me/forums` and `/forums` route answers 503 `forums_unavailable`.
-- Additive only. Not in REQUIRED_SCHEMA. Re-runnable.

create table if not exists public.forum_posts (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.profiles(id) on delete cascade,
  college_id   uuid not null references public.colleges(id) on delete cascade,
  kind         text not null check (kind in ('thought', 'video', 'creator', 'food')),
  title        text not null check (char_length(btrim(title)) between 1 and 80),
  body         text not null default '' check (char_length(body) <= 600),
  url          text check (url is null or (url ~ '^https://' and char_length(url) <= 2000)),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'reported')),
  review_note  text check (review_note is null or char_length(review_note) <= 500),
  reviewed_by  uuid references public.profiles(id) on delete set null,
  reviewed_at  timestamptz,
  reported_by  uuid references public.profiles(id) on delete set null,
  reported_at  timestamptz,
  author_first text not null check (char_length(author_first) between 1 and 40),
  author_year  text check (author_year is null or author_year ~ '^\d{4}$'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint forum_posts_thought_has_body check (kind <> 'thought' or char_length(btrim(body)) > 0),
  constraint forum_posts_link_has_url check (kind not in ('video', 'creator') or url is not null)
);

create index if not exists forum_posts_student_idx on public.forum_posts (student_id, created_at desc);
create index if not exists forum_posts_college_approved_idx on public.forum_posts (college_id, created_at desc)
  where status = 'approved';
create index if not exists forum_posts_status_idx on public.forum_posts (status, created_at);

drop trigger if exists forum_posts_set_updated_at on public.forum_posts;
create trigger forum_posts_set_updated_at before update on public.forum_posts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: author, approved-to-students, assigned counselor; nobody writes from a client
-- ---------------------------------------------------------------------------

alter table public.forum_posts enable row level security;

create or replace function private.forum_is_assigned_counselor(p_student uuid, p_viewer uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = p_student and p.counselor_id = p_viewer)
     and private.is_counselor(p_viewer);
$$;
revoke all on function private.forum_is_assigned_counselor(uuid, uuid) from public, anon;
grant execute on function private.forum_is_assigned_counselor(uuid, uuid) to authenticated, service_role;

drop policy if exists forum_posts_select_author on public.forum_posts;
create policy forum_posts_select_author on public.forum_posts
  for select to authenticated using (student_id = (select auth.uid()));

drop policy if exists forum_posts_select_students on public.forum_posts;
create policy forum_posts_select_students on public.forum_posts
  for select to authenticated using (status = 'approved' and private.user_role((select auth.uid())) = 'student');

drop policy if exists forum_posts_select_counselor on public.forum_posts;
create policy forum_posts_select_counselor on public.forum_posts
  for select to authenticated using (private.forum_is_assigned_counselor(student_id, (select auth.uid())));

-- Revoking at table level also drops any column grant, so a re-run starts clean.
revoke all on public.forum_posts from public, anon, authenticated;
grant select (id, student_id, college_id, kind, title, body, url, status, review_note, reported_at, author_first,
              author_year, created_at, updated_at)
  on public.forum_posts to authenticated;

select private.attach_approval_gate('public.forum_posts');
