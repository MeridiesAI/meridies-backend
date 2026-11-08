// Agreements (typed-name acceptance, 20261111000010): the pure helpers, the token
// lookup, HTML escaping on the public page and in the emails, and the OFF switch.
// No database: the lookups get a fake client.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../src/env.js";
import { AGREEMENT_CONSENT_SENTENCE, AGREEMENT_CONSENT_VERSION } from "../../src/lib/agreementConsent.js";
import {
  AGREEMENT_LINK_DAYS,
  AGREEMENT_TOKEN,
  NOT_CERTIFIED_LINE,
  acceptanceEmails,
  agreementForToken,
  agreementPageBody,
  agreementUrl,
  bodySha256,
  buildCertificate,
  cleanSignerName,
  hashAgreementToken,
  mintAgreementLink,
  parseAcceptForm,
  truncateUserAgent,
} from "../../src/lib/agreements.js";
import { loggedUrl } from "../../src/lib/requestLog.js";
import agreementRoutes from "../../src/routes/agreements.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

test("the body hash is the sha256 of the exact text, byte for byte", () => {
  const text = "Fees: $4,000.\r\nTerm: one year. Café ✓\n";
  assert.equal(bodySha256(text), sha(text));
  assert.notEqual(bodySha256(text), bodySha256(text.trim()), "whitespace counts: nothing is normalized");
  assert.match(bodySha256(text), /^[0-9a-f]{64}$/);
});

test("the certificate carries exactly the recorded fields, in order", () => {
  const cert = buildCertificate({
    title: "Senior year counseling agreement",
    bodySha256: sha("body"),
    signerName: "Ana Ruiz",
    signerEmail: "ana@family.test",
    acceptedAt: new Date("2026-11-07T15:04:05.678Z"),
    ip: "203.0.113.9",
    userAgent: "Mozilla/5.0 Test",
    consentVersion: "v0-PLACEHOLDER",
    practiceName: "Bright Path Counseling",
  });
  assert.equal(
    cert,
    [
      "Agreement acceptance certificate",
      "Agreement: Senior year counseling agreement",
      `Document SHA-256: ${sha("body")}`,
      "Accepted by (typed name): Ana Ruiz",
      "Signer email: ana@family.test",
      "Accepted at (UTC): 2026-11-07T15:04:05.678Z",
      "IP address: 203.0.113.9",
      "User agent: Mozilla/5.0 Test",
      "Consent wording version: v0-PLACEHOLDER",
      "Recorded by Meridies on behalf of Bright Path Counseling.",
      NOT_CERTIFIED_LINE,
    ].join("\n")
  );
  assert.equal(NOT_CERTIFIED_LINE, "Typed-name acceptance; not a certified electronic signature.");
});

test("the certificate says what wasn't recorded instead of leaving a blank", () => {
  const cert = buildCertificate({
    title: "T",
    bodySha256: sha("b"),
    signerName: "Al Bo",
    signerEmail: null,
    acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
    ip: null,
    userAgent: null,
    consentVersion: "v1",
    practiceName: "P",
  });
  assert.match(cert, /^Signer email: not recorded$/m);
  assert.match(cert, /^IP address: not recorded$/m);
  assert.match(cert, /^User agent: not recorded$/m);
});

test("the consent wording is one placeholder, versioned, waiting for legal review", () => {
  assert.equal(AGREEMENT_CONSENT_VERSION, "v0-PLACEHOLDER");
  assert.ok(AGREEMENT_CONSENT_SENTENCE.length > 20 && AGREEMENT_CONSENT_SENTENCE.length < 400);
});

test("signer names: trimmed, spaces collapsed, 2 to 120 characters, no control characters", () => {
  assert.equal(cleanSignerName("  Ana   María  Ruiz "), "Ana María Ruiz");
  assert.equal(cleanSignerName("A"), null);
  assert.equal(cleanSignerName("x".repeat(121)), null);
  assert.equal(cleanSignerName("Ana\u0000Ruiz"), null);
  assert.equal(cleanSignerName("Ana\nRuiz"), "Ana Ruiz");
});

test("the accept form is strict: a name and consent=yes, nothing else, nothing twice", () => {
  assert.deepEqual(parseAcceptForm("signerName=Ana+Ruiz&consent=yes"), { ok: true, signerName: "Ana Ruiz" });
  assert.equal(parseAcceptForm("signerName=Ana+Ruiz").ok, false, "no consent");
  assert.equal(parseAcceptForm("signerName=Ana+Ruiz&consent=on").ok, false, "consent must be yes");
  assert.equal(parseAcceptForm("signerName=A&consent=yes").ok, false, "name too short");
  assert.equal(parseAcceptForm("signerName=Ana+Ruiz&consent=yes&status=accepted").ok, false, "extra field");
  assert.equal(parseAcceptForm("signerName=Ana&signerName=Bo+Bo&consent=yes").ok, false, "repeated field");
  assert.equal(parseAcceptForm("").ok, false);
});

test("user agents are cut to 512 characters", () => {
  assert.equal(truncateUserAgent("x".repeat(600))?.length, 512);
  assert.equal(truncateUserAgent(undefined), null);
  assert.equal(truncateUserAgent("  "), null);
});

test("tokens: 32 random bytes, stored as their sha256, minted on the caller's client", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: null, error: null };
    },
    from: () => {
      throw new Error("mint writes through the RPC only");
    },
  } as unknown as SupabaseClient;
  const now = new Date("2026-11-07T00:00:00.000Z");
  const out = await mintAgreementLink(db, "a1", { publicApiUrl: "https://api.test/", now });
  const token = out.url.split("/agree/")[1]!;
  assert.match(token, AGREEMENT_TOKEN);
  assert.equal(out.url, agreementUrl("https://api.test", token));
  assert.equal(out.url, `https://api.test/agree/${token}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "issue_agreement_link");
  assert.equal(calls[0]!.args.p_agreement, "a1");
  assert.equal(calls[0]!.args.p_token_hash, hashAgreementToken(token));
  assert.equal(calls[0]!.args.p_token_hash, sha(token));
  assert.ok(!JSON.stringify(calls[0]!.args).includes(token), "the plaintext never goes to the database");
  assert.ok(!("p_consent_version" in calls[0]!.args), "the consent version is the server's, never the caller's");
  assert.deepEqual(Object.keys(calls[0]!.args).sort(), ["p_agreement", "p_expires_at", "p_token_hash"]);
  assert.equal(AGREEMENT_LINK_DAYS, 30);
  assert.equal(out.expiresAt.toISOString(), "2026-12-07T00:00:00.000Z");
  const again = await mintAgreementLink(db, "a1", { publicApiUrl: "https://api.test", now });
  assert.notEqual(again.url, out.url, "every send mints a fresh token");
});

test("a mint the database refuses throws (RLS-equivalent check in the RPC)", async () => {
  const db = { rpc: async () => ({ data: null, error: { code: "P0002", message: "nope" } }) } as unknown as SupabaseClient;
  await assert.rejects(mintAgreementLink(db, "a1", { publicApiUrl: "https://api.test" }), (e: { code?: string }) => e.code === "P0002");
});

function fakeSvc(token: Record<string, unknown> | null, agreement: Record<string, unknown> | null): SupabaseClient {
  return {
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          if (table === "agreement_tokens") assert.equal(col === "token_hash" ? val : sha("x"), col === "token_hash" ? val : sha("x"));
          return q;
        },
        maybeSingle: async () => ({ data: table === "agreement_tokens" ? token : agreement, error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

test("token lookup: unknown, malformed, expired, void, accepted and open", async () => {
  const tok = "A".repeat(43);
  const now = new Date("2026-11-07T00:00:00.000Z");
  const future = "2026-12-01T00:00:00.000Z";
  const past = "2026-11-01T00:00:00.000Z";
  const ag = (status: string) => ({ id: "a1", status, title: "T", body_text: "B" });
  assert.equal((await agreementForToken(fakeSvc(null, null), tok, now)).state, "invalid");
  assert.equal((await agreementForToken(fakeSvc({ agreement_id: "a1", expires_at: future }, ag("sent")), "short", now)).state, "invalid");
  assert.equal((await agreementForToken(fakeSvc({ agreement_id: "a1", expires_at: past }, ag("sent")), tok, now)).state, "expired");
  assert.equal((await agreementForToken(fakeSvc({ agreement_id: "a1", expires_at: future }, ag("void")), tok, now)).state, "void");
  assert.equal((await agreementForToken(fakeSvc({ agreement_id: "a1", expires_at: future }, ag("draft")), tok, now)).state, "invalid");
  const open = await agreementForToken(fakeSvc({ agreement_id: "a1", expires_at: future }, ag("sent")), tok, now);
  assert.equal(open.state, "open");
  // An accepted agreement still shows (read-only), even once its link has expired.
  const done = await agreementForToken(fakeSvc({ agreement_id: "a1", expires_at: past }, ag("accepted")), tok, now);
  assert.equal(done.state, "accepted");
  assert.equal(done.state === "accepted" && done.agreement.id, "a1");
});

test("the public page renders the body inert and prints the consent sentence by the box", () => {
  const html = agreementPageBody({
    title: "<b>Plan</b>",
    bodyText: "Terms <script>alert(1)</script> & \"more\"",
    error: null,
  });
  assert.ok(!html.includes("<script>"), "no live script");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;b&gt;Plan&lt;/b&gt;"));
  assert.ok(html.includes(AGREEMENT_CONSENT_SENTENCE));
  assert.match(html, /<input[^>]+type="checkbox"[^>]+name="consent"[^>]+value="yes"/);
  assert.match(html, /<input[^>]+name="signerName"/);
  assert.match(html, /<form method="post">/);
  assert.match(html, /<pre[^>]*>/);
});

test("a signer name with HTML is escaped on the page and in both emails, and the certificate goes in each", () => {
  const evil = `<img src=x onerror=alert(1)>`;
  const certificate = buildCertificate({
    title: "Plan",
    bodySha256: sha("Body"),
    signerName: evil,
    signerEmail: "a@b.test",
    acceptedAt: new Date("2026-11-07T00:00:00.000Z"),
    ip: null,
    userAgent: null,
    consentVersion: "v0-PLACEHOLDER",
    practiceName: "P",
  });
  const page = agreementPageBody({ title: "Plan", bodyText: "Body", error: null, accepted: { signerName: evil, acceptedAt: "2026-11-07T00:00:00.000Z", bodySha256: sha("Body") } });
  assert.ok(!page.includes("<img"), "page");
  assert.ok(!/<form/.test(page), "an accepted agreement is read-only");
  assert.ok(page.includes(sha("Body")) && page.includes(NOT_CERTIFIED_LINE) && page.includes("2026-11-07T00:00:00.000Z"));
  assert.ok(!/IP address|User agent/.test(page), "the public page never shows the signer's IP or browser");
  const mails = acceptanceEmails({ title: "Plan", bodyText: "Body <script>x</script>", certificate, signerName: evil, senderName: "Coach" });
  for (const m of [mails.signer, mails.counselor]) {
    assert.ok(!m.html.includes("<img"), "html escaped");
    assert.ok(!m.html.includes("<script>x"), "body escaped");
    assert.ok(m.text.includes(certificate), "the text carries the certificate verbatim");
    assert.ok(m.text.includes("Body <script>x</script>"), "and the agreement text");
    assert.ok(m.html.includes(NOT_CERTIFIED_LINE));
  }
});

test("the public paths' tokens never reach the logs", () => {
  const token = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXU";
  assert.equal(loggedUrl(`/agree/${token}`), "/agree/…");
  assert.equal(loggedUrl(`//agree/${token}/?x=1`), "/agree/…?x=…");
  assert.equal(loggedUrl("/agreements/abc"), "/agreements/abc");
});

test("switched off (the default): every route answers 404 agreements_off before anything else", async () => {
  assert.notEqual(env.AGREEMENTS_ENABLED, "true", "off by default");
  const app = Fastify();
  app.decorate("authenticate", async () => {
    throw new Error("auth ran while switched off");
  });
  app.register(agreementRoutes);
  await app.ready();
  const id = "11111111-1111-4111-8111-111111111111";
  for (const [method, url] of [
    ["POST", "/agreements"],
    ["GET", "/agreements?contactId=" + id],
    ["GET", `/agreements/${id}`],
    ["POST", `/agreements/${id}/send`],
    ["POST", `/agreements/${id}/void`],
  ] as const) {
    const r = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
    assert.equal(r.statusCode, 404, `${method} ${url}`);
    assert.equal(r.json().code, "agreements_off", `${method} ${url}`);
  }
  for (const method of ["GET", "POST"] as const) {
    const r = await app.inject({ method, url: `/agree/${"A".repeat(43)}`, payload: method === "POST" ? "signerName=Ana+Ruiz&consent=yes" : undefined, headers: method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {} });
    assert.equal(r.statusCode, 404, `${method} /agree`);
    assert.match(r.headers["content-type"] as string, /text\/html/);
    assert.match(r.body, /not available/i);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["x-robots-tag"], "noindex");
  }
  await app.close();
});

test("switched on, the public page sends strict headers (no script allowed) even for a bad token", async () => {
  const prev = env.AGREEMENTS_ENABLED;
  (env as { AGREEMENTS_ENABLED: string }).AGREEMENTS_ENABLED = "true";
  try {
    const app = Fastify();
    app.decorate("authenticate", async () => undefined);
    app.register(agreementRoutes);
    await app.ready();
    const r = await app.inject({ method: "GET", url: "/agree/not-a-token" });
    assert.equal(r.statusCode, 404);
    const csp = String(r.headers["content-security-policy"]);
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/script-src/.test(csp), "no script source at all");
    assert.match(csp, /form-action 'self'/);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["x-robots-tag"], "noindex");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    await app.close();
  } finally {
    (env as { AGREEMENTS_ENABLED: string }).AGREEMENTS_ENABLED = prev;
  }
});
