// Cause 3 of the linked-Doc word count (HANDOFF-word-count.md): pointing an essay at a different Doc used to keep the
// old Doc's text and count. Now the old text goes and the row reads "not read yet" until the new Doc is read (here
// it can't be: the local stack has no Google, so it stays not read yet). Removing the link keeps the text.
import { call, check, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("relink");
const s = await studentOf(c, "relink-student");
const DOC_A = "https://docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit";
const DOC_B = "https://docs.google.com/document/d/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/edit";
const body = "word ".repeat(650).trim();

const make = async () => {
  const r = await call(c.token, "POST", "/application/essays", { studentId: s.id, essayKind: "personal-statement", title: "Relink", body, externalUrl: DOC_A });
  check("an essay with a linked Doc and its text is created", r.status === 201 && r.body?.wordCount === 650, JSON.stringify(r.body));
  return r.body.id;
};

const a = await make();
const relinked = await call(c.token, "PATCH", `/application/essays/${a}`, { externalUrl: DOC_B });
check("a changed link drops the old Doc's count", relinked.status === 200 && relinked.body?.wordCount === 0, JSON.stringify(relinked.body));
check("…and reads as not read yet, not as an empty essay", relinked.body?.readable === false, JSON.stringify(relinked.body));

const b = await make();
const same = await call(c.token, "PATCH", `/application/essays/${b}`, { externalUrl: DOC_A, title: "Renamed" });
check("saving the same link keeps the text", same.status === 200 && same.body?.wordCount === 650, JSON.stringify(same.body));
const removed = await call(c.token, "PATCH", `/application/essays/${b}`, { externalUrl: null });
check("removing the link keeps the text, so typed work isn't lost", removed.status === 200 && removed.body?.wordCount === 650, JSON.stringify(removed.body));

const d = await make();
const withText = await call(c.token, "PATCH", `/application/essays/${d}`, { externalUrl: DOC_B, body: "new text here" });
check("a new link saved together with new text keeps that text", withText.status === 200 && withText.body?.wordCount === 3, JSON.stringify(withText.body));

// Essays sync reads the student's Drive-picked essays too (cause 1); with no Google here nothing is read, but the
// new reads must resolve against the real schema and leave the not-read-yet row as it is.
const sync = await call(c.token, "POST", "/application/essays/sync", { studentId: s.id });
const row = sync.body?.essays?.find((e) => e.id === a);
check("Essays sync still answers, and the relinked row stays not read yet", sync.status === 200 && row?.wordCount === 0 && row?.readable === false, `status ${sync.status} ${JSON.stringify(sync.body?.failed)}`);
