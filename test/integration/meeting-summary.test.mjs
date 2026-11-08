// POST /ai/meeting-summary: who may call it, what it refuses before any model runs, and transcripts on the fake model.
import { check, call, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const notes = "Met with Maya about her fall plan. She will retake the SAT in October and finish the activities list.";

const c = await user("sum-c");
const s = await studentOf(c, "sum-s");
const outsider = await user("sum-out");

const asStudent = await call(s.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: notes });
check("a student can't ask for a meeting summary", asStudent.status === 403, `status ${asStudent.status}`);

const asOutsider = await call(outsider.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: notes });
check("a counselor off the caseload is refused", asOutsider.status === 403 || asOutsider.status === 404, `status ${asOutsider.status}`);

const tooShort = await call(c.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: "hi" });
check("notes that are too short are a 400", tooShort.status === 400, `status ${tooShort.status}`);

const extra = await call(c.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: notes, sneaky: 1 });
check("unknown fields are refused", extra.status === 400, `status ${extra.status}`);

const huge = await call(c.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: "x".repeat(20_001) });
check("notes over the cap are a 400", huge.status === 400, `status ${huge.status}`);

// With a key the call may succeed (200 draft); without one it is a 503. Never a 500, and never filed anywhere.
const ok = await call(c.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: notes });
check(
  "a counselor's call is a draft or an unavailable answer, never a server error",
  (ok.status === 200 && ok.body.status === "draft" && typeof ok.body.summary === "string") || ok.status === 503 || ok.status === 502,
  `status ${ok.status} ${JSON.stringify(ok.body).slice(0, 120)}`
);

// ---------------------------------------------------------------------------
// Transcripts (kind: "transcript"). The API runs with MEETING_SUMMARY_FAKE=fixture (CI and the local stack), so no
// model is called: a part's summary is its first line, the merge joins them, and every answer still passes cleanSummary.
// ---------------------------------------------------------------------------

// Its own counselor and student: the route allows 10 calls a minute per counselor.
const tc = await user("sum-tc");
const ts = await studentOf(tc, "sum-ts");

const vtt = [
  "WEBVTT",
  "",
  "1",
  "00:00:01.000 --> 00:00:04.000 align:start",
  "<v Maya Chen>I will retake the SAT in October.</v>",
  "",
  "2",
  "00:00:04.000 --> 00:00:06.000",
  "<v Maya Chen>I will retake the SAT in October.</v>",
  "",
  "3",
  "00:00:06.000 --> 00:00:09.000",
  "<v Dr. Lee>Good. Send me the activities list by Friday.</v>",
].join("\n");

const pasted = await call(tc.token, "POST", "/ai/meeting-summary", { studentId: ts.id, kind: "transcript", rawNotes: vtt });
check(
  "a pasted transcript comes back as a draft, with the names back in the answer only",
  pasted.status === 200 && pasted.body.status === "draft" && pasted.body.summary.startsWith("Maya Chen said: I will retake the SAT") &&
    pasted.body.transcript?.parts === 1 && pasted.body.transcript?.modelCalls === 1 &&
    JSON.stringify(pasted.body.transcript?.speakers) === JSON.stringify([{ label: "Speaker 1", name: "Maya Chen" }, { label: "Speaker 2", name: "Dr. Lee" }]),
  `status ${pasted.status} ${JSON.stringify(pasted.body).slice(0, 300)}`
);

const upload = await call(tc.token, "POST", "/ai/meeting-summary", {
  studentId: ts.id,
  kind: "transcript",
  meetingDate: "2026-11-07",
  file: { name: "Zoom meeting.vtt", type: "text/vtt", data: Buffer.from("﻿" + vtt.replace(/\n/g, "\r\n")).toString("base64") },
});
check("a .vtt upload comes back as a draft", upload.status === 200 && upload.body.summary === pasted.body.summary, `status ${upload.status} ${JSON.stringify(upload.body).slice(0, 200)}`);

// Long enough for several parts: one call per part and a merge.
const cues = [];
for (let i = 0; i < 900; i++) cues.push(`00:00:01.000 --> 00:00:02.000\n<v ${i % 2 ? "Maya Chen" : "Dr. Lee"}>In section ${i} we went over the essay plan and the campus visits in detail.</v>\n`);
const long = await call(tc.token, "POST", "/ai/meeting-summary", { studentId: ts.id, kind: "transcript", rawNotes: "WEBVTT\n\n" + cues.join("\n") });
check(
  "a long transcript is summarized in parts plus one merge",
  long.status === 200 && long.body.transcript.parts > 1 && long.body.transcript.modelCalls === long.body.transcript.parts + 1 && !/Speaker \d/.test(long.body.summary),
  `status ${long.status} ${JSON.stringify(long.body.transcript ?? long.body).slice(0, 200)}`
);

const tooLong = await call(tc.token, "POST", "/ai/meeting-summary", { studentId: ts.id, kind: "transcript", rawNotes: "We talked about the plan again today. ".repeat(6000) });
check("a transcript over the cap is a 413 transcript_too_long", tooLong.status === 413 && tooLong.body.code === "transcript_too_long", `status ${tooLong.status} ${JSON.stringify(tooLong.body).slice(0, 160)}`);

const empty = await call(tc.token, "POST", "/ai/meeting-summary", { studentId: ts.id, kind: "transcript", rawNotes: "WEBVTT\n\nNOTE nothing said\n" });
check("a transcript with no spoken lines is a 400 transcript_empty", empty.status === 400 && empty.body.code === "transcript_empty", `status ${empty.status}`);

const pdf = await call(tc.token, "POST", "/ai/meeting-summary", { studentId: ts.id, kind: "transcript", file: { name: "notes.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.7").toString("base64") } });
check("a file that isn't a transcript is a 400 transcript_file_type", pdf.status === 400 && pdf.body.code === "transcript_file_type", `status ${pdf.status}`);

const both = await call(tc.token, "POST", "/ai/meeting-summary", { studentId: ts.id, kind: "transcript", rawNotes: vtt, file: { name: "a.vtt", data: "QQ==" } });
check("pasted text and a file together are a 400", both.status === 400, `status ${both.status}`);

const studentTranscript = await call(ts.token, "POST", "/ai/meeting-summary", { studentId: ts.id, kind: "transcript", rawNotes: vtt });
check("a student can't summarize a transcript", studentTranscript.status === 403, `status ${studentTranscript.status}`);

const outsiderTranscript = await call(outsider.token, "POST", "/ai/meeting-summary", { studentId: ts.id, kind: "transcript", rawNotes: vtt });
check("a counselor off the caseload can't either", outsiderTranscript.status === 403 || outsiderTranscript.status === 404, `status ${outsiderTranscript.status}`);

await sql(`insert into public.practice_settings (counselor_id, ai_summaries) values ('${tc.id}', false) on conflict do nothing`);
await sql(`update public.practice_settings set ai_summaries = false where counselor_id = '${tc.id}'`);
const switchedOff = await call(tc.token, "POST", "/ai/meeting-summary", { studentId: ts.id, kind: "transcript", rawNotes: vtt });
check("with AI summaries off a transcript is a calm 403, before any model call", switchedOff.status === 403 && /AI summaries are turned off/.test(switchedOff.body.error ?? ""), `status ${switchedOff.status} ${JSON.stringify(switchedOff.body).slice(0, 160)}`);
await sql(`update public.practice_settings set ai_summaries = true where counselor_id = '${tc.id}'`);
