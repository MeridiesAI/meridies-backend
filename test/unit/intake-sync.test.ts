// The questionnaire sync's read side (lib/intakeFills.ts), the sheet DTOs'
// source, and the activity-type list the database keeps in step with ours.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  INFO_KEY_OF,
  loadIntakeFills,
  questionnaireFields,
  questionnaireRowIds,
  resetIntakeFillsWarning,
  type IntakeFill,
} from "../../src/lib/intakeFills.js";
import { ACTIVITY_TYPES } from "../../src/lib/profileUpdates.js";
import { toSheetActivity, toSheetHonor } from "../../src/lib/studentApplication.js";
import type { StudentInfo } from "../../src/lib/studentPage.js";

type Rpc = Pick<SupabaseClient, "rpc">;

function fakeDb(answer: { data?: unknown; error?: { code?: string; message: string } | null; throws?: boolean }) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const db = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      if (answer.throws) throw new Error("network down");
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  } as unknown as Rpc;
  return { db, calls };
}

function fakeLog() {
  const warns: unknown[] = [];
  const errors: unknown[] = [];
  return { log: { warn: (...a: unknown[]) => void warns.push(a), error: (...a: unknown[]) => void errors.push(a) }, warns, errors };
}

const fill = (over: Partial<IntakeFill>): IntakeFill => ({
  targetTable: "student_academics",
  field: "gpa_unweighted",
  rowId: null,
  filledAt: "2026-10-15T00:00:00Z",
  matchesCurrent: true,
  ...over,
});

test("every info-card key the questionnaire marks is a StudentInfo key", () => {
  const keys = new Set(Object.values(INFO_KEY_OF));
  const infoKeys: Array<keyof StudentInfo> = [
    "highSchool", "gradYear", "gpaWeighted", "gpaUnweighted", "classRank", "sat", "act", "firstGen", "intendedMajors",
  ];
  assert.deepEqual([...keys].sort(), [...infoKeys].sort());
  assert.equal(INFO_KEY_OF["student_academics.sat_superscore"], "sat");
  assert.equal(INFO_KEY_OF["student_personal_details.citizenship"], undefined, "citizenship is never filled");
});

test("questionnaireFields keeps only values still as the questionnaire left them, once each", () => {
  const out = questionnaireFields([
    fill({}),
    fill({}),
    fill({ field: "gpa_weighted", matchesCurrent: false }),
    fill({ targetTable: "profiles", field: "high_school" }),
    fill({ targetTable: "student_academics", field: "gpa_band" }),
    fill({ targetTable: "activities", field: "*", rowId: "r1" }),
  ]);
  assert.deepEqual(out.sort(), ["gpaUnweighted", "highSchool"]);
});

test("questionnaireRowIds picks one sheet's unchanged rows", () => {
  const ids = questionnaireRowIds(
    [
      fill({ targetTable: "activities", field: "*", rowId: "a1" }),
      fill({ targetTable: "activities", field: "*", rowId: "a2", matchesCurrent: false }),
      fill({ targetTable: "awards", field: "*", rowId: "w1" }),
      fill({}),
    ],
    "activities"
  );
  assert.deepEqual([...ids], ["a1"]);
});

test("loadIntakeFills reads the RPC for the student", async () => {
  const { db, calls } = fakeDb({ data: [fill({})] });
  const out = await loadIntakeFills(db, "s1");
  assert.equal(out.length, 1);
  assert.deepEqual(calls, [{ fn: "intake_filled_fields", args: { p_student: "s1" } }]);
});

test("without the migration: no marks, one warning per process", async () => {
  resetIntakeFillsWarning();
  const { log, warns, errors } = fakeLog();
  for (const code of ["PGRST202", "42883", "PGRST205", "42P01"]) {
    const { db } = fakeDb({ error: { code, message: "Could not find the function public.intake_filled_fields" } });
    assert.deepEqual(await loadIntakeFills(db, "s1", log), []);
  }
  assert.equal(warns.length, 1);
  assert.equal(errors.length, 0);
});

test("any other failure is logged and answers no marks, never throws", async () => {
  const { log, errors } = fakeLog();
  assert.deepEqual(await loadIntakeFills(fakeDb({ error: { code: "57014", message: "timeout" } }).db, "s1", log), []);
  assert.deepEqual(await loadIntakeFills(fakeDb({ throws: true }).db, "s1", log), []);
  assert.deepEqual(await loadIntakeFills(fakeDb({ data: [{ field: 5 }] }).db, "s1", log), []);
  assert.deepEqual(await loadIntakeFills(fakeDb({ data: { not: "an array" } }).db, "s1"), []);
  assert.equal(errors.length, 3);
});

test("sheet rows say where they came from", () => {
  assert.equal(toSheetActivity({ id: "a", source: "intake" }).source, "intake");
  assert.equal(toSheetActivity({ id: "a" }).source, "manual");
  assert.equal(toSheetActivity({ id: "a", source: "bogus" }).source, "manual");
  assert.equal(toSheetHonor({ id: "h", source: "import" }).source, "import");
});

test("fromQuestionnaire appears only where the caller read the fills", () => {
  assert.equal("fromQuestionnaire" in toSheetActivity({ id: "a" }), false);
  assert.equal(toSheetActivity({ id: "a" }, { fromQuestionnaire: true }).fromQuestionnaire, true);
  assert.equal(toSheetHonor({ id: "h" }, { fromQuestionnaire: false }).fromQuestionnaire, false);
});

test("the database's activity types are the sheet's ACTIVITY_TYPES", () => {
  const sql = readFileSync(
    new URL("../../supabase/migrations/20261023010002_intake_profile_sync.sql", import.meta.url),
    "utf8"
  );
  const block = /-- ACTIVITY_TYPES begin([\s\S]*?)\]\) -- ACTIVITY_TYPES end/.exec(sql);
  assert.ok(block, "the marked list is in the migration");
  const listed = [...block[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
  assert.deepEqual(listed, [...ACTIVITY_TYPES]);
});
