import assert from "node:assert/strict";
import { test } from "node:test";
import { adjustBody, adjustPrompt, cleanSuggestions, resumeLines, sheetFacts } from "../../src/lib/resumeAdjust.js";

const resume = [
  "Maya Chen",
  "Lincoln High School, Class of 2027",
  "• Was in charge of the robotics team",
  "• Helped at food bank",
  "Skills: Python, Spanish",
].join("\n");
const lines = resumeLines(resume);
const facts = sheetFacts(
  [{ organization: "Tejas Robotics", position: "Captain", description: "Led 12 members to regionals", hours_per_week: 6, weeks_per_year: 30, grade_levels: ["11", "12"] }],
  [{ name: "AP Scholar", recognition_levels: ["national"], grade_levels: ["11"] }]
);

test("resume lines are trimmed and empty ones dropped", () => {
  assert.deepEqual(resumeLines("  A  \n\n B\tC \n"), ["A", "B C"]);
});

test("a suggestion must edit a line the resume has, with the resume's own text as original", () => {
  const out = cleanSuggestions(
    {
      suggestions: [
        { original: "Was in charge of the robotics team", suggested: "Captained Tejas Robotics, leading 12 members to regionals", reason: "Stronger verb; facts from the record" },
        { original: "A line that is not on the resume", suggested: "Something else entirely", reason: "x" },
      ],
    },
    lines,
    facts
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.original, "• Was in charge of the robotics team");
  assert.equal(out[0]!.line, 2);
});

test("no number the resume and the records don't hold", () => {
  const out = cleanSuggestions(
    { suggestions: [{ original: "• Helped at food bank", suggested: "Volunteered 200 hours at the food bank", reason: "Concrete" }] },
    lines,
    facts
  );
  assert.equal(out.length, 0);
});

test("no first person, no unchanged line, one suggestion per line", () => {
  const out = cleanSuggestions(
    {
      suggestions: [
        { original: "• Helped at food bank", suggested: "I helped at my local food bank", reason: "x" },
        { original: "Skills: Python, Spanish", suggested: "Skills: Python, Spanish", reason: "same" },
        { original: "• Helped at food bank", suggested: "Sorted donations at the food bank", reason: "Specific verb" },
        { original: "• Helped at food bank", suggested: "Organized food drives", reason: "dupe" },
      ],
    },
    lines,
    facts
  );
  assert.deepEqual(out.map((s) => s.suggested), ["Sorted donations at the food bank"]);
});

test("a malformed answer gives no suggestions", () => {
  assert.deepEqual(cleanSuggestions({ nope: true }, lines, facts), []);
});

test("the prompt wraps the resume and records as data", () => {
  const p = adjustPrompt(["<b>x</b>"], facts);
  assert.ok(p.includes('kind="untrusted"'));
  assert.ok(!p.includes("<b>"));
});

test("the body is strict", () => {
  assert.throws(() => adjustBody.parse({ documentId: "11111111-1111-1111-1111-111111111111", text: "pasted" }));
});
