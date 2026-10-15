// The questionnaire against held import data (20261023010003) and the
// one-time backfill (20261023010004).
import { call, check, rest, sql, user } from "./harness.mjs";
import { academics, addChange, addItem, makeImport, studentOf } from "./imports-helpers.mjs";

const c = await user("intake-held-c");
const tag = Date.now();

// ---- Held import data beats the student's own questionnaire answer ---------
{
  const email = `intake-held-${tag}@test.local`;
  const token = `intake-held-${tag}-${Math.random().toString(36).slice(2)}`;
  const inv = await sql(`with i as (insert into public.invitations (counselor_id, email, token, full_name) values ('${c.id}', '${email}', '${token}', 'Held Student') returning id) select id from i`);
  const imp = await makeImport(c);
  const item = await addItem(imp, { status: "new_invite", invitationId: inv, name: "Held Student" });
  await addChange(imp, item, { target: "student_academics", field: "gpa_unweighted", value: 3.5, oldValue: null, decision: "auto" });
  await addChange(imp, item, { target: "student_academics", field: "act_composite", value: 30, oldValue: null, decision: "auto" });
  await addChange(imp, item, { target: "student_academics", field: "sat_superscore", value: 1400, oldValue: null, decision: "auto" });
  await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp}'`);
  await sql(`select public.commit_import('${imp}', '${c.id}')`);

  const s = await user("intake-held-s", "student");
  const acc = await rest(s.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: token });
  check("the student accepts", acc.status === 200, `status ${acc.status}`);

  // The questionnaire runs while the import waits.
  const r = await call(s.token, "PATCH", "/auth/me", {
    onboardingComplete: true,
    profile: { intakeAnswers: { gpaType: "unweighted", gpaExact: "3.86", testStatus: "both", actComposite: "31" } },
  });
  check("the questionnaire saves", r.status === 200);
  check("…and fills the empty GPA meanwhile", (await academics(s.id)).gpa_unweighted === 3.86);
  // The student types an SAT on their own (not the questionnaire): that one is theirs.
  await sql(`update public.student_academics set sat_superscore = 1500 where student_id = '${s.id}'`);

  const queue = await rest(c.token, "POST", "/rest/v1/rpc/import_held_queue", {});
  const entry = (queue.body ?? []).find((e) => e.itemId === item);
  const ch = (f) => entry?.changes.find((x) => x.field === f);
  check("the queue says the current GPA came from the questionnaire", ch("gpa_unweighted")?.currentSource === "intake", JSON.stringify(entry?.changes));
  check("…and defaults the import's GPA to accept", ch("gpa_unweighted")?.defaultDecision === "accept");
  check("the questionnaire's ACT defaults to accept too", ch("act_composite")?.defaultDecision === "accept");
  check("a value the student entered elsewhere still defaults to keep_old", ch("sat_superscore")?.defaultDecision === "keep_old" && !ch("sat_superscore")?.currentSource);

  const req = await rest(c.token, "POST", "/rest/v1/rpc/request_held_apply", { p_item: item, p_decisions: {} });
  check("the counselor applies with the defaults", req.status === 200 || req.status === 204, `status ${req.status} ${JSON.stringify(req.body)}`);
  const out = JSON.parse(await sql(`select public.apply_held_item('${item}', '${c.id}')`));
  check("apply reports applied", out.status === "applied", JSON.stringify(out));
  const a = await academics(s.id);
  check("the counselor's imported GPA and ACT win over the questionnaire's", a.gpa_unweighted === 3.5 && a.act_composite === 30, JSON.stringify(a));
  check("the student's own SAT is kept", a.sat_superscore === 1500);

  // The questionnaire never takes the field back afterwards.
  await call(s.token, "PATCH", "/auth/me", { profile: { intakeAnswers: { gpaType: "unweighted", gpaExact: "3.9", testStatus: "both", actComposite: "32" } } });
  const b = await academics(s.id);
  check("a re-saved questionnaire leaves the imported values alone", b.gpa_unweighted === 3.5 && b.act_composite === 30, JSON.stringify(b));
}

// ---- Backfill ------------------------------------------------------------------
{
  const answers = JSON.stringify({ gpaType: "weighted", gpaScale: "5", gpaExact: "4.4", firstGen: "yes",
    activities: [{ category: "Robotics", organization: "Robotics Club", position: "Captain" }] }).replace(/'/g, "''");
  const s = await studentOf(c, "intake-backfill-s");
  const archived = await studentOf(c, "intake-backfill-archived");
  // Answers saved before the trigger existed: written with triggers off for
  // this one session only (session_replication_role), so no other suite is affected.
  for (const id of [s.id, archived.id]) {
    await sql(`set session_replication_role = replica; update public.profiles set profile = profile || jsonb_build_object('intakeAnswers', '${answers}'::jsonb) where id = '${id}'`);
  }
  await sql(`update public.profiles set archived_at = now() where id = '${archived.id}'`);
  check("the seeded answers filled nothing yet", (await academics(s.id)) === null);

  const first = JSON.parse(await sql(`select private.backfill_intake_answers('${s.id}')`));
  check("the backfill fills the student who answered", first.students === 1 && first.changed >= 4 && first.failed === 0, JSON.stringify(first));
  const a = await academics(s.id);
  check("…with the GPA on its scale", a.gpa_weighted === 4.4 && a.gpa_scale === "5.0", JSON.stringify(a));
  check("…the activity row", (await sql(`select source from public.activities where student_id = '${s.id}'`)) === "intake");
  check("…and records the run as a backfill", (await sql(`select count(*) from public.intake_fills where student_id = '${s.id}' and run = 'backfill'`)) === String(first.changed));
  const ev = JSON.parse(await sql(`select metadata from public.progress_events where student_id = '${s.id}' and entity_type = 'intake'`));
  check("one activity row says it was the backfill", ev.questionnaire.run === "backfill");

  const second = JSON.parse(await sql(`select private.backfill_intake_answers('${s.id}')`));
  check("running it again changes nothing", second.students === 1 && second.changed === 0 && second.failed === 0, JSON.stringify(second));
  check("each run writes an audit row", (await sql(`select count(*) from public.audit_log where action = 'intake.backfill' and student_id = '${s.id}'`)) === "2");

  const skippedArchived = JSON.parse(await sql(`select private.backfill_intake_answers('${archived.id}')`));
  check("an archived student is skipped", skippedArchived.students === 0 && (await academics(archived.id)) === null, JSON.stringify(skippedArchived));

  const all = JSON.parse(await sql(`select private.backfill_intake_answers()`));
  check("a run over everyone completes without failures", all.failed === 0 && all.students >= 1, JSON.stringify(all));
  check("…and still leaves the archived student alone", (await academics(archived.id)) === null);

  const direct = await rest(s.token, "POST", "/rest/v1/rpc/backfill_intake_answers", {});
  check("a client can't run the backfill", direct.status >= 400, `status ${direct.status}`);
}
