// Steps for eval cases that do more than talk (AxIS activity drafts, spec 4.10): a counselor message, a click on
// the newest card (Confirm, with the rows to keep; Dismiss; Undo), or moving AxIS's clock forward (the API runs in
// eval clock mode, POST /axis/eval/clock). Each reply's text is kept for the case's checks.
import { API, call, CRON_SECRET, sql } from "../../test/integration/harness.mjs";
import { say } from "./cases.mjs";

/** The answer's text, from the SSE stream's `delta` events. */
export function replyText(sse) {
  let out = "";
  for (const block of String(sse).split("\n\n")) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (event !== "delta" || !data) continue;
    try {
      out += JSON.parse(data).text ?? "";
    } catch {
      // a partial line: skip it
    }
  }
  return out;
}

/** The newest card in the chat with this status. */
async function newest(ctx, status) {
  const id = await sql(`select id from public.axis_actions where conversation_id = '${ctx.conversationId}' and status = '${status}' order by created_at desc limit 1`);
  if (!id) throw new Error(`no ${status} card to click`);
  return id.split("\n")[0];
}

async function click(ctx, path, body = {}) {
  const r = await call(ctx.c.token, "POST", path, body);
  if (r.status !== 200) throw new Error(`${path} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

/**
 * Runs a case's steps in order. A `say` step may carry `replyIncludes` / `replyNever`: a miss is recorded in
 * ctx.misses (a hard-check failure), never thrown, so the case's other checks still run.
 */
export async function runSteps(ctx, steps) {
  ctx.replies = [];
  ctx.misses = [];
  ctx.says = 0;
  for (const step of steps) {
    if ("say" in step) {
      const text = replyText(await say(ctx, step.say));
      ctx.replies.push(text);
      ctx.says++;
      for (const want of step.replyIncludes ?? []) if (!text.includes(want)) ctx.misses.push(`reply to "${step.say.slice(0, 40)}" lacks "${want}"`);
      for (const never of step.replyNever ?? []) if (text.includes(never)) ctx.misses.push(`reply to "${step.say.slice(0, 40)}" has "${never}"`);
    } else if ("confirm" in step) {
      await click(ctx, `/axis/actions/${await newest(ctx, "pending")}/confirm`, step.rows ? { rows: step.rows } : {});
    } else if ("dismiss" in step) {
      await click(ctx, `/axis/actions/${await newest(ctx, "pending")}/dismiss`);
    } else if ("undo" in step) {
      await click(ctx, `/axis/actions/${await newest(ctx, "confirmed")}/undo`);
    } else if ("advanceClock" in step) {
      const r = await fetch(`${API}/axis/eval/clock`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CRON_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ minutes: step.advanceClock }),
      });
      if (r.status !== 200) throw new Error(`the eval clock answered ${r.status} (is the API running with AXIS_EVAL_CLOCK=on?)`);
    } else throw new Error(`unknown step ${JSON.stringify(step)}`);
  }
}
