// A valid input for any AxIS operation, built from its zod schema: the route
// check in axis-ops.test.ts and the local smoke script use it. Not a test file.
import assert from "node:assert/strict";
import type { z, ZodTypeAny } from "zod";
import { getOp } from "../../src/lib/axis/ops/registry.js";

export const SAMPLE_UUID = "11111111-1111-4111-8111-111111111111";

/** Which optional keys of the top-level object to fill: all, none, or just one. */
type Fill = { mode: "all" } | { mode: "required" } | { mode: "one"; key: string };
let fill: Fill = { mode: "all" };
let depth = 0;

function sample(t: ZodTypeAny, key = ""): unknown {
  const def = t._def as { typeName: string } & Record<string, unknown>;
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (t as z.AnyZodObject).shape as Record<string, ZodTypeAny>;
      depth++;
      try {
        const top = depth === 1;
        return Object.fromEntries(
          Object.entries(shape)
            .filter(([k, v]) => !top || !v.isOptional() || fill.mode === "all" || (fill.mode === "one" && fill.key === k))
            .map(([k, v]) => [k, sample(v, k)])
        );
      } finally {
        depth--;
      }
    }
    case "ZodOptional":
    case "ZodNullable":
      return sample(def.innerType as ZodTypeAny, key);
    case "ZodDefault":
      return sample(def.innerType as ZodTypeAny, key);
    case "ZodEffects":
      return sample(def.schema as ZodTypeAny, key);
    case "ZodBranded":
    case "ZodReadonly":
    case "ZodCatch":
      return sample((def.type ?? def.innerType) as ZodTypeAny, key);
    case "ZodPipeline":
      return sample(def.in as ZodTypeAny, key);
    case "ZodLazy":
      return sample((def.getter as () => ZodTypeAny)(), key);
    case "ZodString": {
      const checks = (def.checks as { kind: string; value?: number; regex?: RegExp }[]) ?? [];
      if (checks.some((c) => c.kind === "uuid")) return SAMPLE_UUID;
      if (checks.some((c) => c.kind === "email")) return "someone@example.com";
      if (checks.some((c) => c.kind === "url")) return "https://example.com/page";
      if (checks.some((c) => c.kind === "datetime")) return "2026-11-01T15:00:00.000Z";
      if (checks.some((c) => c.kind === "date")) return "2026-11-01";
      if (checks.some((c) => c.kind === "time")) return "09:30:00";
      const re = checks.find((c) => c.kind === "regex")?.regex;
      if (re) {
        for (const cand of ["2026-11-01", "09:30", "2026-11-01T15:00:00Z", "2026-27", "2026-2027", "2026-11", "#12402e", "2027", "NY", "+15555550123", "https://example.com/page", "someone@example.com", "AB", "ab", "a", "1", "abc", "x-y"]) if (re.test(cand)) return cand;
      }
      const min = checks.find((c) => c.kind === "min")?.value ?? 1;
      const max = checks.find((c) => c.kind === "max")?.value ?? 40;
      if (/email/i.test(key)) return "someone@example.com";
      if (/url|link|href/i.test(key)) return "https://example.com/page";
      return "x".repeat(Math.min(Math.max(min, 4), max));
    }
    case "ZodNumber": {
      const checks = (def.checks as { kind: string; value?: number; inclusive?: boolean }[]) ?? [];
      const min = checks.find((c) => c.kind === "min");
      const max = checks.find((c) => c.kind === "max");
      let n = min ? (min.inclusive === false ? min.value! + 1 : min.value!) : 1;
      if (max && n > max.value!) n = max.value!;
      return n;
    }
    case "ZodBigInt":
      return BigInt(1);
    case "ZodBoolean":
      return true;
    case "ZodDate":
      return new Date("2026-11-01T00:00:00Z");
    case "ZodEnum":
      return (def.values as string[])[0];
    case "ZodNativeEnum":
      return Object.values(def.values as Record<string, unknown>)[0];
    case "ZodLiteral":
      return def.value;
    case "ZodArray": {
      const min = (def.minLength as { value: number } | null)?.value ?? 1;
      return Array.from({ length: Math.max(1, min) }, () => sample(def.type as ZodTypeAny, key));
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = (def.options as ZodTypeAny[] | Map<unknown, ZodTypeAny>) ?? [];
      const first = Array.isArray(options) ? options[0] : [...options.values()][0];
      return sample(first as ZodTypeAny, key);
    }
    case "ZodRecord":
      return {};
    case "ZodTuple":
      return (def.items as ZodTypeAny[]).map((i) => sample(i, key));
    case "ZodNull":
      return null;
    case "ZodAny":
    case "ZodUnknown":
      return "x";
    default:
      throw new Error(`no sample for ${def.typeName}`);
  }
}

export function topShape(t: ZodTypeAny): Record<string, ZodTypeAny> {
  let cur = t;
  while ((cur._def as { typeName: string }).typeName === "ZodEffects") cur = (cur._def as { schema: ZodTypeAny }).schema;
  return (cur as z.AnyZodObject).shape ?? {};
}

/** The fullest input that validates: every optional key, then none, then one at a time (for "one of" refinements). */
export function sampleInput(name: string): Record<string, unknown> {
  const def = getOp(name)!;
  const optional = Object.entries(topShape(def.input as ZodTypeAny)).filter(([, v]) => v.isOptional()).map(([k]) => k);
  const tries: Fill[] = [{ mode: "all" }, ...optional.map((key) => ({ mode: "one" as const, key })), { mode: "required" }];
  let last = "";
  for (const f of tries) {
    fill = f;
    const parsed = def.input.safeParse(sample(def.input as ZodTypeAny));
    fill = { mode: "all" };
    if (parsed.success) return parsed.data as Record<string, unknown>;
    last = JSON.stringify(parsed.error.issues).slice(0, 400);
  }
  assert.fail(`${name}: no generated sample validates: ${last}`);
}

