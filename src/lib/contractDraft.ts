// A contract drafted in Meridies: its sections, merge fields, and the one function that turns them into the
// text a family accepts. Pure on purpose: no imports and only erasable TypeScript, so the demo and the app
// copy this file byte for byte and plain Node can run it with type-stripping.

export type ContractSection =
  | { id: string; kind: "text"; heading: string; body: string }
  | { id: string; kind: "list"; heading: string; items: string[] }
  | { id: string; kind: "clause"; heading: string; body: string };

export const MERGE_FIELDS = ["family_name", "student_name", "counselor_name", "date"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Partial<Record<MergeField, string>>;

export type SignatureBlock = { signerName: string; practiceName: string; signedOn: string; imageSha256: string | null };

// Counted in UTF-16 units (`.length`), like the database column it mirrors.
export const CONTRACT_BODY_MAX = 60000;

// Plain starter wording for the counselor's attorney to review. No promise about admission anywhere.
export const STARTER_SECTIONS: ContractSection[] = [
  {
    id: "services",
    kind: "text",
    heading: "Services",
    body: "{{counselor_name}} will give college admissions guidance to {{student_name}} and {{family_name}}. This can include planning a college list, working on essays and applications, and meeting regularly through the application process.",
  },
  {
    id: "prerequisites",
    kind: "list",
    heading: "Prerequisites",
    items: ["A completed intake form", "A current transcript", "A list of activities and honors"],
  },
  {
    id: "fees",
    kind: "text",
    heading: "Fees and payment terms",
    body: "The fee and when each payment is due are shown on the invoice that comes with this agreement. Please pay each invoice by its due date.",
  },
  {
    id: "cancellation-and-refunds",
    kind: "clause",
    heading: "Cancellation and refunds",
    body: "You may cancel this agreement in writing at any time. Fees for work already done are not refunded. Any fee paid for work not yet started is refunded.",
  },
  {
    id: "no-guarantee-of-admission",
    kind: "clause",
    heading: "No guarantee of admission",
    body: "Colleges make their own decisions. We cannot promise admission to any college, a scholarship, or any other result.",
  },
  {
    id: "confidentiality",
    kind: "clause",
    heading: "Confidentiality",
    body: "We keep your family's information private and share it only as needed to do this work or as the law requires.",
  },
  {
    id: "communication",
    kind: "clause",
    heading: "Communication",
    body: "We will reply to messages within a reasonable time. Meetings are set by agreement. The student is responsible for meeting deadlines and for the accuracy of what is submitted.",
  },
  {
    id: "ending-this-agreement",
    kind: "clause",
    heading: "Ending this agreement",
    body: "This agreement ends when the services are finished or when either side cancels it in writing.",
  },
];

export type RenderResult =
  | { ok: true; title: string; bodyText: string }
  | { ok: false; reason: "unresolved"; fields: string[] }
  | { ok: false; reason: "too_long" };

// Anything between the braces; the name is the trimmed content, compared exactly (case-sensitive).
const FIELD = /\{\{([^{}]*)\}\}/g;
const isField = (name: string): name is MergeField => (MERGE_FIELDS as readonly string[]).includes(name);

// Every string a merge field can sit in, in the order the text reads.
function templated(title: string, sections: ContractSection[]): string[] {
  return [title, ...sections.flatMap((s) => [s.heading, ...(s.kind === "list" ? s.items : [s.body])])];
}

// The fields that are unknown or have no value, by trimmed token text, once each, first seen first.
export function unresolvedFields(title: string, sections: ContractSection[], values: MergeValues): string[] {
  const found = new Set<string>();
  for (const text of templated(title, sections)) {
    for (const m of text.matchAll(FIELD)) {
      const name = m[1].trim();
      if (!isField(name) || !values[name]?.trim()) found.add(name);
    }
  }
  return [...found];
}

// One pass: a value that looks like a field is never expanded again. Only called once nothing is unresolved.
const merge = (text: string, values: MergeValues) => text.replace(FIELD, (_, name: string) => values[name.trim() as MergeField] ?? "");

export function renderContractText(input: { title: string; sections: ContractSection[]; values: MergeValues; signature: SignatureBlock }): RenderResult {
  const { sections, values, signature } = input;
  const fields = unresolvedFields(input.title, sections, values);
  if (fields.length) return { ok: false, reason: "unresolved", fields };
  const m = (text: string) => merge(text, values);
  const title = m(input.title);
  const blocks = sections.map((s, i) => `${i + 1}. ${m(s.heading)}\n${s.kind === "list" ? s.items.map((item) => `- ${m(item)}`).join("\n") : m(s.body)}`);
  const signed = `Signed for ${signature.practiceName} by ${signature.signerName}, ${signature.signedOn}.`;
  const bodyText = [title, ...blocks, signature.imageSha256 ? `${signed}\nSignature image SHA-256: ${signature.imageSha256}` : signed].join("\n\n");
  return bodyText.length > CONTRACT_BODY_MAX ? { ok: false, reason: "too_long" } : { ok: true, title, bodyText };
}

export function addClause(sections: ContractSection[], id: string): ContractSection[] {
  return [...sections, { id, kind: "clause", heading: "New clause", body: "" }];
}

export function removeClause(sections: ContractSection[], id: string): ContractSection[] {
  return sections.filter((s) => s.id !== id || s.kind !== "clause");
}

// A clause swaps with the clause next to it, so the text, list and fee sections above never move.
export function moveClause(sections: ContractSection[], id: string, delta: -1 | 1): ContractSection[] {
  const from = sections.findIndex((s) => s.id === id);
  const to = from + delta;
  if (from < 0 || sections[from].kind !== "clause" || sections[to]?.kind !== "clause") return sections;
  const next = [...sections];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

// "(copy)" always fits inside the 160-character title limit; a cut never leaves half an emoji.
export function copyTitle(title: string): string {
  return `${title.slice(0, 153).replace(/[\uD800-\uDBFF]$/, "")} (copy)`;
}
