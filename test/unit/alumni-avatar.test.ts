import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { alumAvatars, toAlum } from "../../src/routes/outcomes.js";
import { toAvatarRef } from "../../src/lib/studentAvatar.js";

// An alum's uploaded photo is a stored reference to the private student-banners bucket. GET /alumni used to pass it
// through unsignedAvatarUrl, so every uploaded photo read as no photo on the Past students cards.

const ALUM = "6f1c2b0e-5d3a-4c8e-9b7f-0a1b2c3d4e5f";
const OTHER = "0a1b2c3d-4e5f-4c8e-9b7f-6f1c2b0e5d3a";
const path = `${ALUM}/avatar-0123456789abcdef.jpg`;

function fakeStorage() {
  const calls: string[][] = [];
  const svc = {
    storage: {
      from: (bucket: string) => {
        assert.equal(bucket, "student-banners");
        return {
          createSignedUrls: async (paths: string[]) => {
            calls.push(paths);
            return { data: paths.map((p) => ({ path: p, error: null, signedUrl: `https://signed.test/${p}` })), error: null };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { svc, calls };
}

const row = (studentId: string, avatarUrl: string | null) => ({
  student_id: studentId,
  cycle: "2025-2026",
  college_id: null,
  institution_name: null,
  program: null,
  outcome_id: null,
  created_at: "2026-06-01T00:00:00Z",
  student: { full_name: "Jonah Kim", avatar_url: avatarUrl, grad_year: 2026, high_school: "Lincoln", email: "a@example.com" },
  college: null,
});

test("an alum's uploaded photo is signed, an https one passes through, none is null", async () => {
  const google = "https://lh3.googleusercontent.com/a/x";
  const rows = [row(ALUM, toAvatarRef(path)), row(OTHER, google), row("11111111-2222-4333-8444-555555555555", null)];
  const { svc, calls } = fakeStorage();
  const avatars = await alumAvatars(rows, svc);
  assert.deepEqual(calls, [[path]]);
  const out = rows.map((r) => toAlum(r, new Map(), avatars).avatarUrl);
  assert.deepEqual(out, [`https://signed.test/${path}`, google, null]);
});

test("a stored reference is never sent to the app raw", () => {
  assert.equal(toAlum(row(ALUM, toAvatarRef(path))).avatarUrl, null);
});

test("a reference into another student's folder is not signed", async () => {
  const { svc, calls } = fakeStorage();
  const avatars = await alumAvatars([row(OTHER, toAvatarRef(path))], svc);
  assert.deepEqual(calls, []);
  assert.equal(toAlum(row(OTHER, toAvatarRef(path)), new Map(), avatars).avatarUrl, null);
});
