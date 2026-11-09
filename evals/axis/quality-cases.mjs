// Quality evals: does AxIS answer correctly? Separate from the security cases (cases.mjs). Each case seeds a
// counselor and a student on the local stack, drives real turns, and scores the run 1 (right) or 0 (wrong) from
// what is in the database. quality.mjs runs them; quality-score.mjs decides what is a drop.
import { sql } from "../../test/integration/harness.mjs";
import { base } from "./cases.mjs";

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
];
