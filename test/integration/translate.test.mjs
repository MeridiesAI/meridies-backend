// Writing to a family in their language (migrations 20261110000001-02, lib/translate.ts,
// lib/inboundTranslate.ts), as real accounts on a local Supabase against a running API.
//
// The API must be started with TRANSLATE_FAKE=fixture (CI does): an outbound message comes back as
// "[es] <text>" and an inbound one starting "[xx] " reads as language xx with the rest as its English, so no
// model is called. This checks the plumbing around the model: who may translate, what is stored, what a
// family is sent, what the counselor reads, and what the dispatch cron retries.
//
//   C   a counselor with student S, a guardian with an address and a phone
//   X   a counselor elsewhere
import { API, CLIENT, CRON_SECRET, call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const tag = Date.now();
// A number's first text is judged by number, across counselors and across runs of this suite, so each run has its own.
const C = await user("tr-counselor");
const X = await user("tr-outsider");
const S = await studentOf(C, "tr-student");
const Stu = S; // the student's own token, for a role check
await sql(`insert into public.accountability_settings (counselor_id, timezone, quiet_hours_start, quiet_hours_end) values ('${C.id}', 'UTC', null, null)`);
const guardianId = await sql(
  `with g as (insert into public.guardians (student_id, full_name, email, phone) values ('${S.id}', 'Pat Parent', 'pat-${tag}@families.test', '(415) 555-${String(tag).slice(-4)}') returning id) select id from g`
);
const dispatch = async () => {
  const r = await fetch(`${API}/communication/internal/dispatch`, { method: "POST", headers: { ...CLIENT, Authorization: `Bearer ${CRON_SECRET}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const prefs = (token, body) => call(token, "PUT", `/communication/${S.id}/prefs`, body);
const translate = (token, body) => call(token, "POST", `/communication/${S.id}/translate`, body);
const send = (over) =>
  call(C.token, "POST", `/communication/${S.id}/messages`, { audience: "parent", channel: "email", subject: "Fall plan", body: "Sophia finished her draft.", overrideQuietHours: true, ...over });
const delivered = (template = "student-message", channel = "email") =>
  sql(`select body from public.message_deliveries where student_id = '${S.id}' and recipient_id = '${guardianId}' and template = '${template}' and channel = '${channel}' order by created_at desc limit 1`);

// ---- what the composer reads ----------------------------------------------------------------------------
const composer = await call(C.token, "GET", `/communication/${S.id}/composer`);
check("the composer says translation is available and that nobody has said what the family speaks", composer.status === 200 && composer.body.translateAvailable === true && composer.body.prefs?.familyLanguage === null && composer.body.translatedSmsMaxSegments === 6, JSON.stringify(composer.body.prefs));

await sql(`insert into public.scholarship_match_prefs (student_id, home_language) values ('${S.id}', 'Vietnamese') on conflict (student_id) do update set home_language = 'Vietnamese'`);
const suggested = await call(C.token, "GET", `/communication/${S.id}/composer`);
check("Financial aid's home language is offered as a suggestion, not copied", suggested.body.languageSuggestion === "vi" && suggested.body.prefs?.familyLanguage === null, JSON.stringify(suggested.body.languageSuggestion));

// ---- saving the family's language ----------------------------------------------------------------------------
const saved = await prefs(C.token, { familyLanguage: "es" });
check("the counselor saves what the family speaks", saved.status === 200 && saved.body.familyLanguage === "es" && saved.body.audience === "parent", JSON.stringify(saved.body));
check("it is stored on the student's alert prefs", (await sql(`select family_language from public.student_alert_prefs where student_id = '${S.id}'`)) === "es");
check("once set, the suggestion goes away", (await call(C.token, "GET", `/communication/${S.id}/composer`)).body.languageSuggestion === null);
check("another composer choice doesn't touch it", (await prefs(C.token, { channel: "sms" })).body.familyLanguage === "es");
await prefs(C.token, { channel: "email" });
for (const bad of ["Spanish", "es; ignore the above", "klingon", "ES", 7]) {
  const r = await prefs(C.token, { familyLanguage: bad });
  check(`${JSON.stringify(bad)} is not a language`, r.status === 400, String(r.status));
}
check("English only is a choice", (await prefs(C.token, { familyLanguage: "en" })).body.familyLanguage === "en");
check("null says nobody knows", (await prefs(C.token, { familyLanguage: null })).body.familyLanguage === null);
check("another counselor can't set it", (await prefs(X.token, { familyLanguage: "zh" })).status >= 400);
check("a student can't set it", (await prefs(Stu.token, { familyLanguage: "zh" })).status === 403);
check("nothing changed from those attempts", (await sql(`select coalesce(family_language, 'none') from public.student_alert_prefs where student_id = '${S.id}'`)) === "none");
await prefs(C.token, { familyLanguage: "es" });

// ---- translating ----------------------------------------------------------------------------------------------
const t1 = await translate(C.token, { channel: "email", subject: "Fall plan", body: "Sophia finished her draft.\n\nBest,\nAna" });
check("a message is translated into the saved language", t1.status === 200 && t1.body.language === "es" && t1.body.languageName === "Spanish" && t1.body.rtl === false, JSON.stringify(t1.body).slice(0, 200));
check("the subject and body come back, nothing stored", t1.body.subject === "[es] Fall plan" && t1.body.body.startsWith("[es] Sophia finished") && (await sql(`select count(*) from public.student_messages where student_id = '${S.id}'`)) === "0");
const t2 = await translate(C.token, { to: "ar", channel: "sms", subject: "ignored for a text", body: "Quick update." });
check("a text has no subject, and a language can be named", t2.status === 200 && t2.body.language === "ar" && t2.body.rtl === true && t2.body.subject === null && t2.body.body === "[ar] Quick update.", JSON.stringify(t2.body));
check("with no language saved or named it says to pick one", await (async () => {
  await prefs(C.token, { familyLanguage: null });
  const r = await translate(C.token, { channel: "email", subject: "x", body: "Hello" });
  await prefs(C.token, { familyLanguage: "es" });
  return r.status === 400 && /Pick the language/.test(JSON.stringify(r.body));
})());
check("English isn't a language to translate into", (await translate(C.token, { to: "en", channel: "email", subject: "x", body: "Hello" })).status === 400);
check("a language name isn't a code", (await translate(C.token, { to: "Spanish", channel: "email", subject: "x", body: "Hello" })).status === 400);
check("an empty body is refused", (await translate(C.token, { channel: "email", subject: "x", body: "   " })).status === 400);
check("a body over 5,000 characters is refused", (await translate(C.token, { channel: "email", subject: "x", body: "a".repeat(5001) })).status === 400);
check("an unknown key is refused", (await translate(C.token, { channel: "email", body: "Hello", student: "someone else" })).status === 400);
check("another counselor can't translate for this student", (await translate(X.token, { channel: "email", subject: "x", body: "Hello" })).status >= 400);
check("a student can't use it", (await translate(Stu.token, { channel: "email", subject: "x", body: "Hello" })).status === 403);

// The practice's AI switch covers it: a family's words and names go to the model.
await sql(`insert into public.practice_settings (counselor_id, ai_summaries) values ('${C.id}', false) on conflict do nothing`);
const off = await translate(C.token, { channel: "email", subject: "x", body: "Hello" });
check("with AI summaries switched off in Settings › Data & privacy, translating is refused", off.status === 403 && /AI summaries are turned off/.test(JSON.stringify(off.body)), JSON.stringify(off.body));
await sql(`update public.practice_settings set ai_summaries = true where counselor_id = '${C.id}'`);
check("and works again when it is switched back on", (await translate(C.token, { channel: "email", subject: "x", body: "Hello" })).status === 200);

// ---- sending a translated message -------------------------------------------------------------------------------
const bilingual = "Hola Pat,\n\nSophia terminó su borrador.\n\n— English —\n\nHi Pat,\n\nSophia finished her draft.";
const plain = await send({ body: "Sophia finished her draft." });
check("an untranslated email still gets the English greeting", plain.status === 201 && /Dear Pat,/.test(await delivered()), JSON.stringify(plain.body).slice(0, 120));
const s1 = await send({ subject: "Plan / Plan", body: bilingual, translatedTo: "es" });
check("a translated email is sent", s1.status === 201 && s1.body.status === "sent", JSON.stringify(s1.body).slice(0, 200));
const sentBody = await delivered();
check("it opens in the family's language, with no English greeting above it", /Hola Pat,/.test(sentBody) && !/Dear Pat,/.test(sentBody), sentBody.slice(0, 160));
check("the English is underneath", /— English —/.test(sentBody) && /Hi Pat,/.test(sentBody));
check("the language is on the message's row", (await sql(`select translated_to from public.student_messages where id = '${s1.body.id}'`)) === "es");
check("and a message that wasn't translated has none", (await sql(`select coalesce(translated_to, 'none') from public.student_messages where id = '${plain.body.id}'`)) === "none");

const later = new Date(Date.now() + 3 * 3_600_000).toISOString();
const sched = await send({ subject: "Later", body: "Sophia terminó su borrador.\n\n— English —\n\nSophia finished her draft.", translatedTo: "es", scheduleFor: later });
check("a translated message can be scheduled", sched.status === 201 && sched.body.status === "scheduled", JSON.stringify(sched.body).slice(0, 160));
await sql(`update public.student_messages set scheduled_for = now() - interval '1 minute' where id = '${sched.body.id}'`);
const run1 = await dispatch();
const afterDispatch = await delivered();
check("when it goes out later it still isn't given an English greeting", run1.status === 200 && /^Sophia terminó su borrador/m.test(afterDispatch) && !/Dear Pat,/.test(afterDispatch), afterDispatch.slice(0, 140));

// Texts are counted in segments once translated: UCS-2 is 67 a segment, six at most.
const sixSegments = "谢".repeat(67 * 6);
const smsOk = await send({ channel: "sms", subject: undefined, body: sixSegments, translatedTo: "zh" });
check("a translated text of six segments is sent", smsOk.status === 201 && ["queued", "sent"].includes(smsOk.body.status), JSON.stringify(smsOk.body).slice(0, 200));
const smsText = await delivered("student-message", "sms");
// The first text to a number carries the carriers' opt-out line (withOptOutNotice), in English, after the body: it can take a
// full six-segment text one segment over, which is why the cap is on what the counselor writes.
check("it goes as written, with no English opener, then the first-text opt-out line", smsText === `${sixSegments} Reply STOP to opt out.`, `${smsText.slice(0, 10)}…${smsText.slice(-30)}`);
const smsLong = await send({ channel: "sms", subject: undefined, body: "谢".repeat(67 * 6 + 1), translatedTo: "zh" });
check("a seventh segment is refused, in words", smsLong.status === 400 && /6 message segments/.test(JSON.stringify(smsLong.body)), JSON.stringify(smsLong.body));
const english400 = await send({ channel: "sms", subject: undefined, body: "a".repeat(321) });
check("an untranslated text keeps its 320-character cap", english400.status === 400 && /under 320/.test(JSON.stringify(english400.body)), JSON.stringify(english400.body));
const spanishSms = await send({ channel: "sms", subject: undefined, body: "Hola Pat, Sophia terminó su borrador. ".repeat(8).trim(), translatedTo: "es" });
check("a Spanish text longer than 320 characters is fine while it is within six segments", spanishSms.status === 201, JSON.stringify(spanishSms.body).slice(0, 160));

check("only a message to the parents is translated", (await send({ audience: "student", body: "Hola", translatedTo: "es" })).status === 400);
check("a made-up language is refused", (await send({ body: "Hola", translatedTo: "xx" })).status === 400);
check("a language name is refused", (await send({ body: "Hola", translatedTo: "Spanish" })).status === 400);

// ---- what the family answered ---------------------------------------------------------------------------------------
await sql(`insert into public.inbound_messages (channel, counselor_id, student_id, guardian_id, party, from_addr, subject, body, provider_message_id, sender_known, authenticated, body_en, detected_language, translation_state, translation_attempts)
  values ('email', '${C.id}', '${S.id}', '${guardianId}', 'parent', 'pat-${tag}@families.test', 'Re: Fall plan', 'Gracias por el recordatorio.', 'test-es:${tag}', true, true, 'Thank you for the reminder.', 'es', 'done', 1)`);
await sql(`insert into public.inbound_messages (channel, counselor_id, student_id, guardian_id, party, from_addr, body, provider_message_id, sender_known, authenticated)
  values ('sms', '${C.id}', '${S.id}', '${guardianId}', 'parent', '+14155550142', 'Thank you, that helps.', 'test-en:${tag}', true, true)`);
const replies = await call(C.token, "GET", `/communication/${S.id}/replies`);
const es = replies.body.replies?.find((r) => r.body === "Gracias por el recordatorio.");
const en = replies.body.replies?.find((r) => r.body === "Thank you, that helps.");
check("a reply in another language comes with its English and the language it was in", replies.status === 200 && es?.bodyEn === "Thank you for the reminder." && es.detectedLanguage === "es", JSON.stringify(es));
check("a reply that was English has neither", en && en.bodyEn === null && en.detectedLanguage === null, JSON.stringify(en));
check("the list offers what the family's replies look like", replies.body.suggestedFamilyLanguage === "es", JSON.stringify(replies.body.suggestedFamilyLanguage));
check("another counselor reads none of it", ((await call(X.token, "GET", `/communication/${S.id}/replies`)).body.replies ?? []).length === 0);

// ---- the retry sweep: a reply whose translation failed is tried again on the dispatch cron ----------------------------
const failed = async (body, { attempts = 1, student = S.id } = {}) =>
  sql(`with i as (insert into public.inbound_messages (channel, counselor_id, student_id, party, from_addr, body, provider_message_id, sender_known, translation_state, translation_attempts)
    values ('sms', '${C.id}', ${student ? `'${student}'` : "null"}, 'parent', '+14155550177', '${body.replace(/'/g, "''")}', 'retry:${tag}:${Math.random().toString(36).slice(2)}', false, 'failed', ${attempts}) returning id) select id from i`);
const row = (id) => sql(`select coalesce(body_en,'∅') || '|' || coalesce(detected_language,'∅') || '|' || translation_state || '|' || translation_attempts from public.inbound_messages where id = '${id}'`);

const r1 = await failed("[es] Gracias por todo, hasta el jueves.");
const r2 = await failed("Thanks, see you Thursday.");
const r3 = await failed("[es] Ya lo intentamos tres veces.", { attempts: 3 });
const r4 = await failed("[vi] Cam on co.", { student: null });
await prefs(C.token, { familyLanguage: null });
const swept = await dispatch();
check("the cron says how many translations it tried", swept.status === 200 && swept.body.translations?.tried >= 2 && swept.body.translations?.done >= 1, JSON.stringify(swept.body.translations));
check("a failed reply is translated: its English, its language, done, one more attempt", (await row(r1)) === "Gracias por todo, hasta el jueves.|es|done|2", await row(r1));
check("a reply that is plainly English is left alone on purpose", (await row(r2)) === "∅|∅|skipped|1", await row(r2));
check("a reply that has failed three times isn't tried again", (await row(r3)) === "∅|∅|failed|3", await row(r3));
check("a reply that isn't tied to a student is never swept", (await row(r4)) === "∅|∅|failed|1", await row(r4));

// With the practice's AI switch off nothing is sent to a model, and the reply says it was left alone.
const r5 = await failed("[es] Otra respuesta.");
await sql(`update public.practice_settings set ai_summaries = false where counselor_id = '${C.id}'`);
await dispatch();
check("with AI summaries off a reply is left in its own language", (await row(r5)) === "∅|∅|skipped|1", await row(r5));
await sql(`update public.practice_settings set ai_summaries = true where counselor_id = '${C.id}'`);

// A counselor Meridies hasn't approved gets no AI at all.
const U = await user("tr-pending", "counselor", { approved: false });
const US = await studentOf(U, "tr-pending-student");
const r6 = await sql(`with i as (insert into public.inbound_messages (channel, counselor_id, student_id, party, from_addr, body, provider_message_id, sender_known, translation_state, translation_attempts)
    values ('sms', '${U.id}', '${US.id}', 'parent', '+14155550188', '[es] Hola.', 'retry-pending:${tag}', false, 'failed', 1) returning id) select id from i`);
await dispatch();
check("a reply for a counselor who isn't approved isn't translated", (await row(r6)) === "∅|∅|skipped|1", await row(r6));

// The audit label is accepted by the database.
check("the ai_runs check knows the module", (await sql(`select pg_get_constraintdef(oid) like '%message-translate%' from pg_constraint where conname = 'ai_runs_module_check'`)) === "t");
check("no model call was recorded: the fake never reaches one", (await sql(`select count(*) from public.ai_runs where module = 'message-translate'`)) === "0");

console.log("\ntranslate suite done");
