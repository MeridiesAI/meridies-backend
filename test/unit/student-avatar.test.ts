import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AVATAR_REF_PREFIX,
  AVATAR_STALE_MS,
  avatarCleanup,
  avatarObjectPath,
  isExternalAvatarUrl,
  isOwnAvatarPath,
  parseAvatarRef,
  signAvatarUrls,
  toAvatarRef,
  unsignedAvatarUrl,
} from "../../src/lib/studentAvatar.js";
import { toMeridiesUser } from "../../src/lib/serialize.js";

const ME = "6f1c2b0e-5d3a-4c8e-9b7f-0a1b2c3d4e5f";
const OTHER = "0a1b2c3d-4e5f-4c8e-9b7f-6f1c2b0e5d3a";

test("avatarObjectPath: the student's own folder, avatar-<16 hex>.jpg, fresh each time", () => {
  const a = avatarObjectPath(ME);
  const b = avatarObjectPath(ME);
  assert.match(a, new RegExp(`^${ME}/avatar-[0-9a-f]{16}\\.jpg$`));
  assert.notEqual(a, b);
  assert.ok(isOwnAvatarPath(a, ME));
  assert.throws(() => avatarObjectPath("../etc"));
});

test("isOwnAvatarPath: exactly this student's avatar shape", () => {
  const ok = `${ME}/avatar-0123456789abcdef.jpg`;
  assert.ok(isOwnAvatarPath(ok, ME));
  for (const bad of [
    `${OTHER}/avatar-0123456789abcdef.jpg`, // another student's folder
    `${ME}/avatar-0123456789abcdef.png`,
    `${ME}/avatar-0123456789ABCDEF.jpg`,
    `${ME}/avatar-0123456789abcde.jpg`,
    `${ME}/banner.jpg`,
    `${ME}/x/avatar-0123456789abcdef.jpg`,
    `${ME}/../${OTHER}/avatar-0123456789abcdef.jpg`,
    `/${ME}/avatar-0123456789abcdef.jpg`,
    `${ME}/avatar-0123456789abcdef.jpg?x=1`,
    `${ME}avatar-0123456789abcdef.jpg`,
    "",
    null,
    42,
  ]) {
    assert.equal(isOwnAvatarPath(bad, ME), false, String(bad));
  }
  assert.equal(isOwnAvatarPath(ok, "not-a-uuid"), false);
});

test("stored references round-trip, and only inside the row's own folder", () => {
  const path = `${ME}/avatar-0123456789abcdef.jpg`;
  const ref = toAvatarRef(path);
  assert.equal(ref, `${AVATAR_REF_PREFIX}${path}`);
  assert.ok(ref.startsWith("storage:student-banners/"));
  assert.equal(parseAvatarRef(ref, ME), path);
  // A student who writes another student's reference into their own row gets nothing signed.
  assert.equal(parseAvatarRef(ref, OTHER), null);
  for (const bad of [path, `storage:branding/${path}`, `storage:student-banners/${ME}/banner.jpg`, "https://x.test/a.jpg", null]) {
    assert.equal(parseAvatarRef(bad, ME), null, String(bad));
  }
});

test("external URLs: https passes through unchanged, anything else is no photo", () => {
  const google = "https://lh3.googleusercontent.com/a/abc=s96-c";
  assert.ok(isExternalAvatarUrl(google));
  assert.equal(unsignedAvatarUrl(google), google);
  for (const bad of [
    "http://example.com/a.jpg",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    toAvatarRef(`${ME}/avatar-0123456789abcdef.jpg`),
    "not a url",
    `https://x.test/${"a".repeat(2100)}`,
    null,
    undefined,
  ]) {
    assert.equal(unsignedAvatarUrl(bad), null, String(bad));
  }
});

test("toMeridiesUser never returns a raw stored reference", () => {
  const row = {
    id: ME,
    full_name: "Sam",
    email: "s@x.test",
    role: "student",
    onboarding_step: 0,
    onboarding_complete: true,
    counselor_id: OTHER,
    avatar_url: toAvatarRef(`${ME}/avatar-0123456789abcdef.jpg`),
    timezone: null,
    headline: null,
    hometown: null,
    high_school: null,
    grad_year: null,
    title: null,
    profile: {},
    counselor_approved_at: null,
  };
  const plain = toMeridiesUser(row as never);
  assert.equal(plain.avatarUrl, null);
  assert.equal("avatarEditable" in plain, false);
  const signed = toMeridiesUser(row as never, { avatarUrl: "https://signed.test/x", avatarEditable: true });
  assert.equal(signed.avatarUrl, "https://signed.test/x");
  assert.equal(signed.avatarEditable, true);
});

function fakeStorage(answer: (paths: string[]) => unknown) {
  const calls: string[][] = [];
  const svc = {
    storage: {
      from: (bucket: string) => {
        assert.equal(bucket, "student-banners");
        return {
          createSignedUrls: async (paths: string[]) => {
            calls.push(paths);
            return answer(paths);
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { svc, calls };
}

test("signAvatarUrls: one batch for stored references, https through, the rest null", async () => {
  const mine = `${ME}/avatar-0123456789abcdef.jpg`;
  const google = "https://lh3.googleusercontent.com/a/x";
  const { svc, calls } = fakeStorage((paths) => ({
    data: paths.map((p) => ({ path: p, error: null, signedUrl: `https://signed.test/${p}`, signedURL: null })),
    error: null,
  }));
  const THIRD = "11111111-2222-4333-8444-555555555555";
  const out = await signAvatarUrls(svc, [
    { id: ME, avatar_url: toAvatarRef(mine) },
    { id: OTHER, avatar_url: google },
    // A reference into someone else's folder is never signed.
    { id: THIRD, avatar_url: toAvatarRef(mine) },
    { id: "44444444-2222-4333-8444-555555555555", avatar_url: null },
  ]);
  assert.deepEqual(calls, [[mine]]);
  assert.equal(out.get(ME), `https://signed.test/${mine}`);
  assert.equal(out.get(OTHER), google);
  assert.equal(out.get(THIRD), null);
  assert.equal(out.get("44444444-2222-4333-8444-555555555555"), null);
});

test("signAvatarUrls: no references means no Storage call; failures read as no photo", async () => {
  const none = fakeStorage(() => assert.fail("should not be called"));
  const out = await signAvatarUrls(none.svc, [{ id: ME, avatar_url: null }]);
  assert.equal(out.get(ME), null);

  const ref = toAvatarRef(`${ME}/avatar-0123456789abcdef.jpg`);
  const failing = fakeStorage(() => ({ data: null, error: new Error("down") }));
  assert.equal((await signAvatarUrls(failing.svc, [{ id: ME, avatar_url: ref }])).get(ME), null);
  const throwing = fakeStorage(() => {
    throw new Error("boom");
  });
  assert.equal((await signAvatarUrls(throwing.svc, [{ id: ME, avatar_url: ref }])).get(ME), null);
  assert.equal((await signAvatarUrls(null, [{ id: ME, avatar_url: ref }])).get(ME), null);
});

test("avatarCleanup: removes only stale unsaved avatar-*.jpg, keeps the saved one and the banner", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const old = new Date(now - AVATAR_STALE_MS - 1000).toISOString();
  const fresh = new Date(now - 60_000).toISOString();
  const saved = `${ME}/avatar-aaaaaaaaaaaaaaaa.jpg`;
  const { remove, unsaved } = avatarCleanup(
    [
      { name: "avatar-aaaaaaaaaaaaaaaa.jpg", created_at: old }, // the saved photo
      { name: "avatar-bbbbbbbbbbbbbbbb.jpg", created_at: old }, // abandoned
      { name: "avatar-cccccccccccccccc.jpg", created_at: fresh }, // maybe still on its way
      { name: "avatar-dddddddddddddddd.jpg", created_at: null }, // unreadable time: kept, counted
      { name: "3f2a.jpg", created_at: old }, // a banner
      { name: "avatar-evil.jpg", created_at: old },
    ],
    ME,
    saved,
    now
  );
  assert.deepEqual(remove, [`${ME}/avatar-bbbbbbbbbbbbbbbb.jpg`]);
  assert.equal(unsaved, 2);
});
