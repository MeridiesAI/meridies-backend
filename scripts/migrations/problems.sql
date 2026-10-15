-- What the Apply migrations workflow checks before and after an apply (read-only):
-- every public table with RLS on and the restrictive approval_gate policy, and
-- storage.objects with the gate. One row per problem; none means all is well.
-- The same rules as ci.yml's RLS check and test/integration/approval-db.test.mjs.
select 'rls-off:' || tablename as problem from pg_tables where schemaname = 'public' and not rowsecurity
union all
select 'no-approval-gate:' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
   and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'approval_gate' and not p.polpermissive)
union all
select 'no-approval-gate:storage.objects'
 where not exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'approval_gate' and not polpermissive)
order by 1
;
