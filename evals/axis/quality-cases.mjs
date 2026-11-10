// Quality evals: does AxIS answer correctly? Separate from the security cases (cases.mjs). Each case seeds a
// counselor and a student on the local stack, drives real turns, and scores the run 1 (right) or 0 (wrong) from
// what is in the database. quality.mjs runs them; quality-score.mjs decides what is a drop.
//
// fact-gpa is a lookup AxIS answers in code, with no model call (lib/axis/compiler.ts), so it checks that path.
// The ai-* cases ask what only the model can answer (a document, several facts at once, a comparison). Each also
// checks that the model really answered: if a change to the code path starts answering one of them, it scores 0 and
// says so, because the case would no longer test the model.
import { readFileSync } from "node:fs";
import { sql } from "../../test/integration/harness.mjs";
import { addTask, base, plantDocument } from "./cases.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** The newest answer in the conversation. */
const lastAnswer = (ctx) =>
  sql(`select content from public.ai_messages
       where conversation_id = '${ctx.conversationId}' and role = 'assistant'
       order by created_at desc
       limit 1`);

/** Whether the model answered this run: an AxIS model call by this run's counselor (lib/axis/llm.ts openRun). */
const modelAnswered = async (ctx) =>
  Number(await sql(`select count(*) from public.ai_runs
                    where actor_id = '${ctx.c.id}' and module = 'axis' and created_at >= '${ctx.since}'`)) > 0;

/** An ai-* case's score: 1 only when the answer is right and the model gave it. */
async function scoreAi(ctx, isRight) {
  const answer = await lastAnswer(ctx);
  if (!(await modelAnswered(ctx))) return { score: 0, note: `answered without the model; rewrite the question: ${answer.slice(0, 60)}` };
  return { score: isRight(answer) ? 1 : 0, note: answer.slice(0, 80) };
}

export const QUALITY_CASES = [
  {
    id: "fact-gpa",
    title: "Factual: student GPA",
    async seed(tag) {
      const ctx = await base(tag);
      await sql(`insert into public.student_academics (student_id, gpa_unweighted, gpa_scale)
                 values ('${ctx.s.id}', 3.87, '4.0')`);
      return ctx;
    },
    turns: ["What's Maya's GPA?"],
    async check(ctx) {
      const answer = await sql(`select content from public.ai_messages
                                where conversation_id = '${ctx.conversationId}' and role = 'assistant'
                                order by created_at desc
                                limit 1`);
      const correct = /\b3\.870?\b/.test(answer);
      return { score: correct ? 1 : 0, note: answer.slice(0, 80) };
    },
  },
  {
    id: "ai-resume-read",
    title: "Model: reads a fact out of her resume",
    async seed(tag) {
      const ctx = await base(tag);
      await plantDocument(ctx, "resume.pdf", "resume", fixture("quality-resume.txt"));
      return ctx;
    },
    turns: ["What does Maya's resume say about robotics?"],
    // The resume: grew the team from 3 to 22 members; 2nd at the state championship.
    check: (ctx) => scoreAi(ctx, (a) => /\b22\b/.test(a) && /\b(2nd|second)\b/i.test(a)),
  },
  {
    id: "ai-rundown",
    title: "Model: several facts from her record in one answer",
    async seed(tag) {
      const ctx = await base(tag);
      await sql(`insert into public.student_academics (student_id, gpa_unweighted, gpa_scale, sat_superscore)
                 values ('${ctx.s.id}', 3.87, '4.0', 1480)`);
      await addTask(ctx, "Draft the Why Cornell essay");
      await addTask(ctx, "Ask Ms. Patel for a recommendation letter");
      return ctx;
    },
    // "needs" is a judgement word (lib/axis/lexicon.ts), which keeps the question off the code path.
    turns: ["Give me a quick rundown on Maya: her GPA, her SAT, and the tasks she still needs to finish."],
    check: (ctx) =>
      scoreAi(ctx, (a) => /\b3\.87\b/.test(a) && /\b1,?480\b/.test(a) && /why cornell/i.test(a) && /patel/i.test(a)),
  },
  {
    id: "ai-transcript-lowest",
    title: "Model: compares grades on her transcript",
    async seed(tag) {
      const ctx = await base(tag);
      await plantDocument(ctx, "transcript.pdf", "transcript", fixture("quality-transcript.txt"));
      return ctx;
    },
    turns: ["On her transcript, which AP class has her lowest grade?"],
    // Every other AP grade is an A or A-; AP Calculus BC is the one B+.
    check: (ctx) => scoreAi(ctx, (a) => /calculus/i.test(a) && /\bB\s?\+|\bB plus\b/i.test(a)),
  },
];
