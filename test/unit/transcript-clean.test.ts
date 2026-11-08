// lib/transcript.ts: VTT/SRT/plain transcripts to speaker turns, neutral speaker labels, and chunking for map-reduce.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHUNK_LIMIT,
  chunkTurns,
  MAX_CHUNKS,
  MAX_TRANSCRIPT,
  neutralizeSpeakers,
  parseTranscript,
  prepareTranscript,
  restoreSpeakers,
  type Turn,
} from "../../src/lib/transcript.js";
import { readTranscriptFile } from "../../src/lib/documentText.js";

const VTT = [
  "﻿WEBVTT",
  "Kind: captions",
  "Language: en",
  "",
  "NOTE This is a comment",
  "spanning two lines",
  "",
  "STYLE",
  "::cue { color: lime }",
  "",
  "1",
  "00:00:01.000 --> 00:00:03.500 align:start position:10% line:0",
  "<v Maya Chen>Hi, thanks for meeting &amp; talking.</v>",
  "",
  "2",
  "00:00:03.500 --> 00:00:05.000",
  "<v Maya Chen>Hi, thanks for meeting &amp; talking.</v>",
  "",
  "intro-cue",
  "00:00:05.000 --> 00:00:08.000",
  "<v.loud Maya Chen><c.yellow>I will retake</c> the <i>SAT</i> in October.</v>",
  "",
  "00:00:08.000 --> 00:00:10.000",
  "<v Dr. Lee>Great&nbsp;plan. <00:00:09.000>Send me the list.</v>",
].join("\r\n");

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:02,000 X1:100 X2:200 Y1:10 Y2:20",
  "{\\an8}Jordan Park: We looked at",
  "three schools.",
  "",
  "2",
  "00:00:02,000 --> 00:00:04,000",
  "Jordan Park: We looked at",
  "three schools.",
  "",
  "3",
  "00:00:04,000 --> 00:00:06,000",
  "Alex Kim: I'll draft the essay by Friday.",
  "",
].join("\n");

test("WebVTT: header, NOTE/STYLE blocks, cue ids, timestamps with settings, tags, entities, BOM and CRLF are removed", () => {
  const turns = parseTranscript(VTT);
  assert.deepEqual(turns, [
    { speaker: "Maya Chen", text: "Hi, thanks for meeting & talking. I will retake the SAT in October." },
    { speaker: "Dr. Lee", text: "Great plan. Send me the list." },
  ]);
  const flat = JSON.stringify(turns);
  for (const junk of ["WEBVTT", "-->", "NOTE", "lime", "Kind", "position", "<", "&amp;", "&nbsp;", "﻿", "\r", "intro-cue"]) {
    assert.ok(!flat.includes(junk), `left ${junk}`);
  }
});

test("SRT: cue numbers, comma timestamps, positioning and {\\an8} go; duplicate cues collapse; speakers come from 'Name:'", () => {
  assert.deepEqual(parseTranscript(SRT), [
    { speaker: "Jordan Park", text: "We looked at three schools." },
    { speaker: "Alex Kim", text: "I'll draft the essay by Friday." },
  ]);
});

test("rolling auto-captions that extend the previous line keep only the longer line", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:02.000",
    "so the plan is",
    "",
    "00:00:02.000 --> 00:00:03.000",
    "so the plan is",
    "to apply early",
    "",
    "00:00:03.000 --> 00:00:04.000",
    "to apply early",
    "to apply early",
  ].join("\n");
  assert.deepEqual(parseTranscript(vtt), [{ speaker: null, text: "so the plan is to apply early" }]);
});

test("pasted plain text: leading timestamps go, labels repeated on two or more lines are speakers, prose colons are not", () => {
  const pasted = [
    "[00:00:01] Maya: I visited two campuses.",
    "00:12 Counselor: Which one did you like?",
    "Maya: The second one.",
    "Counselor: Good.",
    "",
    "Note: we ran out of time.",
  ].join("\n");
  assert.deepEqual(parseTranscript(pasted), [
    { speaker: "Maya", text: "I visited two campuses." },
    { speaker: "Counselor", text: "Which one did you like?" },
    { speaker: "Maya", text: "The second one." },
    { speaker: "Counselor", text: "Good." },
    { speaker: null, text: "Note: we ran out of time." },
  ]);
});

test("Otter-style 'Name  0:03' header lines label the lines that follow", () => {
  const otter = ["Maya Chen  0:03", "I finished the list.", "", "Sam Ortiz  0:10", "Thanks, send it over."].join("\n");
  assert.deepEqual(parseTranscript(otter), [
    { speaker: "Maya Chen", text: "I finished the list." },
    { speaker: "Sam Ortiz", text: "Thanks, send it over." },
  ]);
});

test("empty and garbage input yield no turns", () => {
  assert.deepEqual(parseTranscript(""), []);
  assert.deepEqual(parseTranscript("﻿WEBVTT\n\nNOTE nothing\n"), []);
  assert.deepEqual(parseTranscript("1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:02,000 --> 00:00:03,000\n"), []);
  assert.deepEqual(parseTranscript("<b></b> &amp;&nbsp;"), [{ speaker: null, text: "&" }]);
});

test("speakers become Speaker 1..N in order of first appearance, deterministically, case-insensitively", () => {
  const turns: Turn[] = [
    { speaker: "Dr. Lee", text: "a" },
    { speaker: "Maya Chen", text: "b" },
    { speaker: "dr. lee", text: "c" },
    { speaker: null, text: "d" },
  ];
  const a = neutralizeSpeakers(turns);
  const b = neutralizeSpeakers(turns);
  assert.deepEqual(a, b);
  assert.deepEqual(a.turns.map((t) => t.speaker), ["Speaker 1", "Speaker 2", "Speaker 1", null]);
  assert.deepEqual(a.speakers, [
    { label: "Speaker 1", name: "Dr. Lee" },
    { label: "Speaker 2", name: "Maya Chen" },
  ]);
  assert.equal(restoreSpeakers("Speaker 2 will email Speaker 1. Speaker 12 is unknown.", a.speakers), "Maya Chen will email Dr. Lee. Speaker 12 is unknown.");
});

test("prepareTranscript sends no speaker name: only neutral labels reach the model's text", () => {
  const p = prepareTranscript(VTT);
  assert.ok(!p.text.includes("Maya Chen") && !p.text.includes("Dr. Lee"));
  assert.ok(p.text.startsWith("Speaker 1: Hi, thanks"));
  assert.ok(p.chunks.every((c) => !c.includes("Maya Chen") && !c.includes("Dr. Lee")));
  // The figure source is the spoken words only: no label digits.
  assert.ok(!/Speaker \d/.test(p.source));
  assert.equal(p.chunks.length, 1);
});

test("prepareTranscript refuses an empty transcript and one over the cap, with codes", () => {
  assert.throws(() => prepareTranscript("WEBVTT\n\n"), (e: { statusCode?: number; code?: string }) => e.statusCode === 400 && e.code === "transcript_empty");
  const long = Array.from({ length: 30_000 }, (_, i) => `Speaker${i % 2 ? "A" : "B"}: We talked about the plan again today.`).join("\n");
  assert.ok(long.length > MAX_TRANSCRIPT);
  assert.throws(() => prepareTranscript(long), (e: { statusCode?: number; code?: string }) => e.statusCode === 413 && e.code === "transcript_too_long");
});

const words = (s: string) => s.replace(/\bSpeaker \d+: /g, " ").split(/\s+/).filter(Boolean);

function sampleTurns(n: number, sentenceLen = 90): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < n; i++) {
    const sentences = Array.from({ length: 1 + (i % 7) }, (_, j) => `Turn ${i} sentence ${j} ${"word ".repeat(Math.max(1, sentenceLen / 5 - 4)).trim()}.`);
    out.push({ speaker: `Speaker ${1 + (i % 3)}`, text: sentences.join(" ") });
  }
  return out;
}

test("chunks never lose or duplicate text, and each stays within the limit", () => {
  const turns = sampleTurns(900);
  const chunks = chunkTurns(turns);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= CHUNK_LIMIT, `chunk of ${c.length}`);
  assert.deepEqual(words(chunks.join("\n")), words(turns.map((t) => t.text).join(" ")));
});

test("chunks break between sentences, and a chunk that starts mid-turn repeats the speaker label", () => {
  const turns: Turn[] = [{ speaker: "Speaker 1", text: Array.from({ length: 1500 }, (_, i) => `Sentence number ${i} is here.`).join(" ") }];
  const chunks = chunkTurns(turns);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.startsWith("Speaker 1: Sentence number"), c.slice(0, 40));
    assert.ok(c.endsWith("is here."), c.slice(-40));
  }
});

test("an unpunctuated run (auto-captions) is cut at whitespace, never mid-word", () => {
  const run = Array.from({ length: 6000 }, (_, i) => `w${i}`).join(" ");
  const chunks = chunkTurns([{ speaker: null, text: run }]);
  for (const c of chunks) assert.ok(c.length <= CHUNK_LIMIT);
  assert.deepEqual(words(chunks.join(" ")), words(run));
});

test("a transcript at the cap fits in MAX_CHUNKS parts", () => {
  const turns = sampleTurns(3000, 140);
  let text = "";
  const kept: Turn[] = [];
  for (const t of turns) {
    if (text.length + t.text.length + 14 > MAX_TRANSCRIPT) break;
    kept.push(t);
    text += `${t.speaker}: ${t.text}\n`;
  }
  assert.ok(text.length > MAX_TRANSCRIPT - 2000);
  assert.ok(chunkTurns(kept).length <= MAX_CHUNKS);
});

test("readTranscriptFile reads .vtt, .srt, .txt and refuses other types", () => {
  const ok = readTranscriptFile(Buffer.from(VTT), "Zoom meeting.vtt", null);
  assert.ok(ok.ok && ok.text.includes("WEBVTT"));
  const srt = readTranscriptFile(Buffer.from(SRT), "call.SRT", "application/x-subrip");
  assert.ok(srt.ok);
  assert.ok(readTranscriptFile(Buffer.from("Maya: hi\nSam: hello"), "notes.txt", "text/plain").ok);
  const pdf = readTranscriptFile(Buffer.from("%PDF-1.7"), "meeting.pdf", "application/pdf");
  assert.deepEqual(pdf, { ok: false, reason: "type" });
  const exe = readTranscriptFile(Buffer.from("MZ"), "run.exe", null);
  assert.deepEqual(exe, { ok: false, reason: "type" });
  const big = readTranscriptFile(Buffer.alloc(1024 * 1024 + 1, 97), "big.vtt", null);
  assert.deepEqual(big, { ok: false, reason: "too_large" });
});

test("hostile input at the raw cap is cleaned in linear time", () => {
  const hostile = ["<v.".repeat(200_000), "<a".repeat(300_000), "Name: ".repeat(100_000), "a.".repeat(300_000)];
  for (const raw of hostile) {
    const t0 = performance.now();
    try {
      prepareTranscript(raw);
    } catch {
      // too long or empty is fine; only the time matters here
    }
    assert.ok(performance.now() - t0 < 3000, `took ${Math.round(performance.now() - t0)} ms`);
  }
});
