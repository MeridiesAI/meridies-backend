/**
 * Time saved: the monthly emails. Headline totals only, a link to the page that
 * shows every calculation, an unsubscribe link, never a student's name, and the
 * "estimated" label kept wherever a default figure was used.
 */
import type { KpiReport } from "./report.js";

export type RenderedEmail = { subject: string; html: string; text: string; headers: Record<string, string> };
export type FirmTotals = { month: string; hoursSaved: number; valueOfTime: number | null; completions: number; students: number };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const hours = (h: number) => `${h} ${h === 1 ? "hour" : "hours"}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const monthName = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};
const unsubscribeHeaders = (url: string) => ({ "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
const ESTIMATED = "Some figures are estimated from Meridies defaults. Update them in Settings to make this exact.";

function layout(title: string, lines: string[], link: string, unsubscribe: string, address: string): { html: string; text: string } {
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1f2937;max-width:560px">
<h2 style="font-size:20px">${esc(title)}</h2>
${lines.map((l) => `<p style="font-size:15px;line-height:1.5">${esc(l)}</p>`).join("\n")}
<p><a href="${esc(link)}" style="color:#4338ca">See how each number was calculated</a></p>
<p style="font-size:12px;color:#6b7280"><a href="${esc(unsubscribe)}" style="color:#6b7280">Unsubscribe from these monthly emails</a></p>
<p style="font-size:12px;color:#6b7280">Meridies · ${esc(address)}</p>
</body></html>`;
  const text = [title, "", ...lines, "", `See how each number was calculated: ${link}`, "", `Unsubscribe: ${unsubscribe}`, "", `Meridies · ${address}`].join("\n");
  return { html, text };
}

export function renderConsultantEmail(r: KpiReport, link: string, unsubscribeUrl: string, address: string): RenderedEmail {
  const title = `Your time saved in ${monthName(r.month)}`;
  const lines = [`${hours(r.hoursSaved)} saved across ${plural(r.students, "student", "students")}.`];
  const value = r.valueOfTime !== null ? `${money(r.valueOfTime)} of your time${r.valueIsEstimate ? " (estimated)" : ""}` : null;
  const extra = r.extraStudents
    ? `room for up to ${plural(r.extraStudents.upTo, "more student", "more students")} (based on ${plural(r.extraStudents.basedOnMonths, "month", "months")})`
    : null;
  if (value && extra) lines.push(`That's ${value}, or ${extra}.`);
  else if (value) lines.push(`That's ${value}.`);
  else if (extra) lines.push(`That's ${extra}.`);
  const estimated = r.valueIsEstimate || r.byTask.some((t) => t.lines.some((l) => l.estimate));
  if (estimated) lines.push(ESTIMATED);
  return { subject: title, ...layout(title, lines, link, unsubscribeUrl, address), headers: unsubscribeHeaders(unsubscribeUrl) };
}

export function renderFirmEmail(t: FirmTotals, firmName: string, link: string, unsubscribeUrl: string, address: string): RenderedEmail {
  const title = `${firmName}: time saved in ${monthName(t.month)}`;
  const lines = [
    `${hours(t.hoursSaved)} saved across ${plural(t.students, "student", "students")} by your consultants (${plural(t.completions, "finished task", "finished tasks")}).`,
  ];
  if (t.valueOfTime !== null) lines.push(`That's ${money(t.valueOfTime)} of their time, at each consultant's own rate.`);
  return { subject: title, ...layout(title, lines, link, unsubscribeUrl, address), headers: unsubscribeHeaders(unsubscribeUrl) };
}
