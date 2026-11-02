// A parent replies to an email: which address did they reply to, what did they
// actually write (not the quoted history), is it a person, and who sent it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareAddress,
  isAutomatedMail,
  replyAddress,
  stripQuotedReply,
  tokenFromRecipients,
} from "../../src/lib/inboundEmail.js";

const TOKEN = "0123456789abcdef01234567";

test("replyAddress / tokenFromRecipients round-trip, whatever case the mail system gives back", () => {
  const addr = replyAddress(TOKEN, "reply.meridiesai.com");
  assert.equal(addr, `r-${TOKEN}@reply.meridiesai.com`);
  assert.equal(tokenFromRecipients([addr], "reply.meridiesai.com"), TOKEN);
  assert.equal(tokenFromRecipients([addr.toUpperCase()], "reply.meridiesai.com"), TOKEN);
  assert.equal(tokenFromRecipients([`Brandon <${addr}>`], "reply.meridiesai.com"), TOKEN);
});

test("tokenFromRecipients ignores other domains, bad tokens, and picks ours out of many", () => {
  assert.equal(tokenFromRecipients([`r-${TOKEN}@evil.com`], "reply.meridiesai.com"), null);
  assert.equal(tokenFromRecipients(["r-short@reply.meridiesai.com"], "reply.meridiesai.com"), null);
  assert.equal(tokenFromRecipients(["someone@reply.meridiesai.com"], "reply.meridiesai.com"), null);
  assert.equal(tokenFromRecipients([], "reply.meridiesai.com"), null);
  assert.equal(
    tokenFromRecipients(["team@school.org", `r-${TOKEN}@reply.meridiesai.com`], "reply.meridiesai.com"),
    TOKEN
  );
  // A lookalike that merely ends with our domain is not our domain.
  assert.equal(tokenFromRecipients([`r-${TOKEN}@notreply.meridiesai.com`], "reply.meridiesai.com"), null);
  assert.equal(tokenFromRecipients([`r-${TOKEN}@reply.meridiesai.com.evil.com`], "reply.meridiesai.com"), null);
});

test("stripQuotedReply keeps what the parent wrote and drops Gmail/Apple quoting", () => {
  const body = [
    "Thanks! Tuesday at 4 works for us.",
    "",
    "Ann",
    "",
    "On Mon, Nov 2, 2026 at 9:14 AM Brandon Cha <hello@meridiesai.com> wrote:",
    "> Hi Ann,",
    "> Can we meet this week?",
  ].join("\n");
  assert.equal(stripQuotedReply(body), "Thanks! Tuesday at 4 works for us.\n\nAnn");
});

test("stripQuotedReply handles a wrapped 'wrote:' line, Outlook headers, and '> ' only quoting", () => {
  assert.equal(
    stripQuotedReply("Yes please.\n\nOn Mon, Nov 2, 2026 at 9:14 AM Brandon Cha\n<hello@meridiesai.com> wrote:\n> old"),
    "Yes please."
  );
  assert.equal(
    stripQuotedReply("Sounds good\n\n-----Original Message-----\nFrom: Brandon\nSent: Monday\nSubject: Meeting\n\nold text"),
    "Sounds good"
  );
  assert.equal(
    stripQuotedReply("Sounds good\n\nFrom: Brandon Cha <hello@meridiesai.com>\nSent: Monday, November 2, 2026 9:14 AM\nTo: Ann\nSubject: Meeting\n\nold"),
    "Sounds good"
  );
  assert.equal(stripQuotedReply("Line one\n> quoted\n> more"), "Line one");
});

test("stripQuotedReply never returns nothing: an all-quoted or empty reply keeps the original", () => {
  const onlyQuote = "> Hi Ann,\n> Can we meet?";
  assert.equal(stripQuotedReply(onlyQuote), onlyQuote);
  assert.equal(stripQuotedReply("   \n"), "");
  assert.equal(stripQuotedReply("On Monday, Ann wrote:\n> hi"), "On Monday, Ann wrote:\n> hi");
});

test("stripQuotedReply drops a '-- ' signature delimiter and what follows", () => {
  assert.equal(stripQuotedReply("Got it.\n-- \nAnn Lee\nSent from my iPhone"), "Got it.");
});

test("stripQuotedReply is linear on adversarial input", () => {
  const nasty = ("On " + "a ".repeat(20_000) + "\n").repeat(20) + "wrote:";
  const start = process.hrtime.bigint();
  stripQuotedReply(nasty);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 1500, `took ${ms}ms`);
});

test("isAutomatedMail: out-of-office, bounces and bulk mail are not a family's reply", () => {
  assert.equal(isAutomatedMail({ "auto-submitted": "auto-replied" }, "ann@example.com"), true);
  assert.equal(isAutomatedMail({ "Auto-Submitted": "auto-generated" }, "ann@example.com"), true);
  assert.equal(isAutomatedMail({ precedence: "bulk" }, "ann@example.com"), true);
  assert.equal(isAutomatedMail({ "x-autoreply": "yes" }, "ann@example.com"), true);
  // Outlook stamps this on ordinary mail to say "don't auto-reply to me"; it is not a sign the mail is automated.
  assert.equal(isAutomatedMail({ "x-auto-response-suppress": "All" }, "ann@example.com"), false);
  assert.equal(isAutomatedMail({}, "MAILER-DAEMON@mail.example.com"), true);
  assert.equal(isAutomatedMail({}, "postmaster@example.com"), true);
  assert.equal(isAutomatedMail({}, "noreply@school.org"), true);
  assert.equal(isAutomatedMail({ "auto-submitted": "no" }, "ann@example.com"), false);
  assert.equal(isAutomatedMail({ precedence: "list" }, "ann@example.com"), false);
  assert.equal(isAutomatedMail({}, "ann@example.com"), false);
});

test("bareAddress pulls the address out of a From header, lowercased", () => {
  assert.equal(bareAddress('"Lee, Ann" <Ann@Example.com>'), "ann@example.com");
  assert.equal(bareAddress("ann@example.com"), "ann@example.com");
  assert.equal(bareAddress("Ann <ann+school@example.com>"), "ann+school@example.com");
  assert.equal(bareAddress("not an address"), null);
  assert.equal(bareAddress(""), null);
});
