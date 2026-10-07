/**
 * IPEDS Admissions (ADM) survey: what each school weighs in admission and
 * whether it uses test scores. Published once a year by NCES as a zipped CSV
 * (https://nces.ed.gov/ipeds/datacenter/data/ADM<year>.zip); loaded by
 * scripts/ingest/ipeds-admissions.ts into college_admission_factors.
 *
 * Only schools already in the catalog (by unitid) are written, so the Scorecard
 * ingest decides which schools exist and this one only describes them. A
 * curated test policy on colleges is never overwritten; a Scorecard-made row
 * with none takes the IPEDS one.
 */

import { inflateRawSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";

export const IPEDS_DATA_URL = "https://nces.ed.gov/ipeds/datacenter/data";

export type Consideration = "required" | "recommended" | "considered" | "not-considered";

/** ADM survey codes, 2023 onward: 1 required, 2 recommended, 5 considered but not required, 3 not considered. */
export function consideration(code: string | undefined): Consideration | null {
  switch ((code ?? "").trim()) {
    case "1":
      return "required";
    case "2":
      return "recommended";
    case "5":
      return "considered";
    case "3":
      return "not-considered";
    default:
      return null;
  }
}

export function testPolicyFrom(c: Consideration | null): "required" | "optional" | "blind" | "recommended" | null {
  if (c === "required") return "required";
  if (c === "recommended") return "recommended";
  if (c === "considered") return "optional";
  if (c === "not-considered") return "blind";
  return null;
}

/** ADMCON1..12, in survey order. */
export const ADMCON_COLUMNS = [
  "gpa", "class_rank", "record", "college_prep", "recommendations", "competencies",
  "test_scores", "english_proficiency", "other_test", "work_experience", "essay", "legacy",
] as const;

export type AdmissionFactors = {
  unitid: number;
  factors: Record<Exclude<(typeof ADMCON_COLUMNS)[number], "other_test">, Consideration | null>;
  testPolicy: ReturnType<typeof testPolicyFrom>;
};

export function mapAdmissionRow(row: Record<string, string>): AdmissionFactors | null {
  const unitid = Number(row.UNITID);
  if (!Number.isInteger(unitid) || unitid <= 0) return null;
  const factors = {} as AdmissionFactors["factors"];
  ADMCON_COLUMNS.forEach((name, i) => {
    if (name === "other_test") return;
    factors[name] = consideration(row[`ADMCON${i + 1}`]);
  });
  return { unitid, factors, testPolicy: testPolicyFrom(factors.test_scores) };
}

/** RFC 4180 CSV, header row first. Small and dependency-free: the ADM file is ~2,000 rows. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/**
 * The first entry of a zip whose name matches, inflated. Reads the central
 * directory, so it handles the data-descriptor layout NCES files use.
 */
export function readZipEntry(zip: Buffer, match: (name: string) => boolean): Buffer | null {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (match(name)) {
      const lNameLen = zip.readUInt16LE(local + 26);
      const lExtraLen = zip.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(start, start + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Write one year's factors for the schools in the catalog. */
export async function writeAdmissionFactors(
  svc: SupabaseClient,
  rows: AdmissionFactors[],
  year: string,
  verifiedAt: string
): Promise<{ upserted: number; skipped: number }> {
  let upserted = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { data: found, error } = await svc
      .from("colleges")
      .select("id, unitid, catalog_source, test_policy")
      .in("unitid", chunk.map((r) => r.unitid));
    if (error) throw new Error(`read colleges: ${error.code}`);
    const byUnitid = new Map(((found ?? []) as Record<string, unknown>[]).map((c) => [Number(c.unitid), c]));
    const out = chunk
      .filter((r) => byUnitid.has(r.unitid))
      .map((r) => ({
        college_id: String(byUnitid.get(r.unitid)!.id),
        unitid: r.unitid,
        data_year: year,
        ...r.factors,
        test_policy: r.testPolicy,
        provenance: "sourced",
        source_url: `${IPEDS_DATA_URL}/ADM${year}.zip`,
        source_verified_at: verifiedAt,
      }));
    skipped += chunk.length - out.length;
    if (!out.length) continue;
    const { error: e2 } = await svc.from("college_admission_factors").upsert(out, { onConflict: "college_id" });
    if (e2) throw new Error(`upsert factors: ${e2.code}`);
    upserted += out.length;

    // A school the catalog took from Scorecard has no curated policy: use this one.
    for (const r of chunk) {
      const c = byUnitid.get(r.unitid);
      if (!c || c.catalog_source !== "scorecard" || c.test_policy || !r.testPolicy) continue;
      await svc.from("colleges").update({ test_policy: r.testPolicy }).eq("id", String(c.id)).is("test_policy", null);
    }
  }
  return { upserted, skipped };
}
