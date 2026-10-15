import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MISSING_TABLE_TTL_MS,
  collegePhotosFor,
  loadCollegePhotos,
  publicUrl,
  resetCollegePhotoCache,
  toCollegePhoto,
  type CollegePhotoRow,
} from "../../src/lib/collegePhotos.js";
import { toListCollege } from "../../src/lib/studentApplication.js";
import { toCollegeRef } from "../../src/lib/eventsHub.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
const row = (id: string): CollegePhotoRow => ({
  college_id: id,
  storage_path: `166683/${sha}-1280.jpg`,
  thumb_path: `166683/${sha}-500.jpg`,
  width: 1280,
  height: 853,
  credit: "Example Photographer",
  license: "CC BY-SA 4.0",
  license_url: "https://creativecommons.org/licenses/by-sa/4.0",
  source_url: "https://commons.wikimedia.org/wiki/File:Great_dome.jpg",
  commons_title: "File:Great dome.jpg",
});

type Answer = { data: unknown; error: { code?: string; message: string } | null } | Error;
/** Just enough of supabase-js: from("college_photos").select(...).in(...), answering in turn. */
function fakeDb(answers: Answer[]) {
  const calls: { table: string; ids: string[] }[] = [];
  const db = {
    from: (table: string) => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => {
          calls.push({ table, ids });
          const next = answers.length > 1 ? answers.shift()! : answers[0]!;
          if (next instanceof Error) throw next;
          return next;
        },
      }),
    }),
  };
  return { db: db as never, calls };
}
const quiet = () => {
  const warned: object[] = [];
  return { warned, log: { warn: (o: object) => void warned.push(o) } };
};

test("publicUrl points at the public bucket on this project, path segments encoded", () => {
  assert.equal(publicUrl(`166683/${sha}-500.jpg`), `http://127.0.0.1:54321/storage/v1/object/public/college-photos/166683/${sha}-500.jpg`);
});

test("toCollegePhoto: the DTO carries both sizes and the full attribution", () => {
  const p = toCollegePhoto(row("c1"), "MIT");
  assert.deepEqual(p, {
    url: `http://127.0.0.1:54321/storage/v1/object/public/college-photos/166683/${sha}-1280.jpg`,
    thumbUrl: `http://127.0.0.1:54321/storage/v1/object/public/college-photos/166683/${sha}-500.jpg`,
    width: 1280,
    height: 853,
    alt: "MIT campus",
    credit: "Example Photographer",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Great_dome.jpg",
    title: "File:Great dome.jpg",
  });
  assert.equal(toCollegePhoto(undefined, "MIT"), null);
});

test("loadCollegePhotos: rows by college id, ids deduped and chunked, blanks ignored", async () => {
  resetCollegePhotoCache();
  const { db, calls } = fakeDb([{ data: [row("c1")], error: null }]);
  const ids = ["c1", "c1", null, "", ...Array.from({ length: 250 }, (_, i) => `x${i}`)];
  const m = await loadCollegePhotos(db, ids);
  assert.equal(m.get("c1")?.credit, "Example Photographer");
  assert.equal(calls.length, 2, "251 ids in two chunks of at most 200");
  assert.equal(calls[0]!.ids.length, 200);
  assert.equal(calls[0]!.table, "college_photos");
  const none = fakeDb([]);
  assert.equal((await loadCollegePhotos(none.db, [])).size, 0);
  assert.equal(none.calls.length, 0, "no ids, no read");
});

test("loadCollegePhotos: a missing table is no photos, remembered for five minutes", async () => {
  resetCollegePhotoCache();
  const { db, calls } = fakeDb([{ data: null, error: { code: "42P01", message: 'relation "public.college_photos" does not exist' } }]);
  const { warned, log } = quiet();
  const t0 = 1_000_000;
  assert.equal((await loadCollegePhotos(db, ["c1"], log, t0)).size, 0);
  assert.equal((await loadCollegePhotos(db, ["c1"], log, t0 + 60_000)).size, 0);
  assert.equal(calls.length, 1, "the second read inside the window is skipped");
  assert.equal(warned.length, 0, "an unapplied migration isn't a warning");
  await loadCollegePhotos(db, ["c1"], log, t0 + MISSING_TABLE_TTL_MS + 1);
  assert.equal(calls.length, 2, "asked again once the window passes");

  for (const code of ["PGRST205", "42703"]) {
    resetCollegePhotoCache();
    const f = fakeDb([{ data: null, error: { code, message: "missing" } }]);
    assert.equal((await loadCollegePhotos(f.db, ["c1"])).size, 0, code);
  }
});

test("loadCollegePhotos: any other error, or a throw, is no photos and a warning, never a failed request", async () => {
  resetCollegePhotoCache();
  const { db, calls } = fakeDb([{ data: null, error: { code: "57014", message: "statement timeout" } }]);
  const { warned, log } = quiet();
  assert.equal((await loadCollegePhotos(db, ["c1"], log)).size, 0);
  await loadCollegePhotos(db, ["c1"], log);
  assert.equal(calls.length, 2, "not cached: the table is there");
  assert.equal(warned.length, 2);

  const thrown = fakeDb([new Error("fetch failed")]);
  assert.equal((await loadCollegePhotos(thrown.db, ["c1"], log)).size, 0);
  assert.equal(warned.length, 3);
});

test("collegePhotosFor serializes with each college's own name", async () => {
  resetCollegePhotoCache();
  const { db } = fakeDb([{ data: [row("c1")], error: null }]);
  const m = await collegePhotosFor(db, [{ id: "c1", name: "MIT" }, { id: "c2", name: "Yale" }]);
  assert.equal(m.get("c1")?.alt, "MIT campus");
  assert.equal(m.has("c2"), false);
});

test("a college list row and an event's college ref carry the photo, or null", () => {
  const photos = new Map([["c1", row("c1")]]);
  const listed = toListCollege({ id: "l1", college_id: "c1", name: "MIT", college: { id: "c1", name: "Massachusetts Institute of Technology", slug: "mit" } }, new Map(), photos);
  assert.equal(listed.collegePhoto?.alt, "Massachusetts Institute of Technology campus");
  assert.match(listed.collegePhoto?.thumbUrl ?? "", /-500\.jpg$/);
  assert.equal(toListCollege({ id: "l2", college_id: null, name: "Typed by hand" }, new Map(), photos).collegePhoto, null);
  assert.equal(toListCollege({ id: "l3", college_id: "c1", name: "MIT", college: { id: "c1" } }).collegePhoto, null, "no photos read");

  assert.equal(toCollegeRef({ id: "c1", slug: "mit", name: "MIT", aka: [] }, photos).photo?.credit, "Example Photographer");
  assert.equal(toCollegeRef({ id: "c1", slug: "mit", name: "MIT", aka: [] }).photo, null);
});
