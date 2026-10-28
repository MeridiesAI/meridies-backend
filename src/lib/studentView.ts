/**
 * The signed-in student's own preferences (SV Demo v2): the Overview banner,
 * the theme, and how reminders reach them. One `student_preferences` row,
 * student-written (RLS: their own row only), counselor-readable.
 *
 * Not to be confused with `student_alert_prefs`, which the counselor writes
 * and which decides whether parents are copied on accountability alerts. This
 * module never reads or writes that table.
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { badRequest, fromPostgrest } from "./errors.js";
import { visibilityUnavailable } from "./polygonVisibility.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

type Row = Record<string, unknown>;

export const BANNER_PRESETS = ["pattern", "forest", "dusk", "sand"] as const;
export const THEMES = ["light", "dark", "system"] as const;
export const BANNER_BUCKET = "student-banners";
export const BANNER_MAX_BYTES = 5 * 1024 * 1024;
export const BANNER_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

export type BannerPreset = (typeof BANNER_PRESETS)[number];
export type Theme = (typeof THEMES)[number];

export type StudentPreferences = {
  bannerPreset: BannerPreset;
  /** The Storage path of an uploaded banner, or null for the preset. */
  bannerImagePath: string | null;
  /** A one-hour signed URL for that image; null when there is none or it can't be read. */
  bannerImageUrl: string | null;
  theme: Theme;
  /** The student's own switch for their strength profile (20261028000005); true until saved. */
  showStrengthProfile: boolean;
  notifications: {
    smsEnabled: boolean;
    smsPhone: string | null;
    emailEnabled: boolean;
    emailAddress: string | null;
  };
  updatedAt: string | null;
};

/**
 * A phone number as typed, normalized to E.164. Spaces, dots, dashes and
 * brackets go; what is left must be a "+" and 7 to 15 digits. No country is
 * guessed for a number without one: a reminder sent to the wrong country is
 * worse than asking.
 */
export const e164 = z
  .string()
  .trim()
  .max(40)
  .transform((v) => v.replace(/[\s().-]/g, ""))
  .refine((v) => /^\+[1-9]\d{6,14}$/.test(v), {
    message: "Use the full international number, starting with + (e.g. +15551234567)",
  });

export const preferencesPatch = z
  .object({
    bannerPreset: z.enum(BANNER_PRESETS),
    bannerImagePath: z.string().trim().max(300).nullable(),
    theme: z.enum(THEMES),
    showStrengthProfile: z.boolean(),
    smsEnabled: z.boolean(),
    smsPhone: e164.nullable(),
    emailEnabled: z.boolean(),
    emailAddress: z.string().trim().email().max(320).nullable(),
  })
  .partial()
  .strict();

export type PreferencesPatch = z.infer<typeof preferencesPatch>;

const DEFAULTS = {
  banner_preset: "pattern",
  banner_image_path: null,
  theme: "light",
  show_strength_profile: true,
  sms_enabled: false,
  sms_phone: null,
  email_enabled: false,
  email_address: null,
  updated_at: null,
} satisfies Row;

async function readRow(db: SupabaseClient, studentId: string): Promise<Row> {
  const { data, error } = await db
    .from("student_preferences")
    .select("*")
    .eq("student_id", studentId)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  return (data as Row | null) ?? { ...DEFAULTS };
}

async function signedBannerUrl(db: SupabaseClient, path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await db.storage.from(BANNER_BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

async function toDto(db: SupabaseClient, r: Row): Promise<StudentPreferences> {
  const path = typeof r.banner_image_path === "string" ? r.banner_image_path : null;
  return {
    bannerPreset: (BANNER_PRESETS as readonly string[]).includes(String(r.banner_preset))
      ? (r.banner_preset as BannerPreset)
      : "pattern",
    bannerImagePath: path,
    bannerImageUrl: await signedBannerUrl(db, path),
    theme: (THEMES as readonly string[]).includes(String(r.theme)) ? (r.theme as Theme) : "light",
    // A row from before the migration has no column: shown.
    showStrengthProfile: r.show_strength_profile !== false,
    notifications: {
      smsEnabled: r.sms_enabled === true,
      smsPhone: typeof r.sms_phone === "string" ? r.sms_phone : null,
      emailEnabled: r.email_enabled === true,
      emailAddress: typeof r.email_address === "string" ? r.email_address : null,
    },
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
  };
}

/** The student's preferences, or the defaults when they have saved none. */
export async function loadPreferences(db: SupabaseClient, studentId: string): Promise<StudentPreferences> {
  return toDto(db, await readRow(db, studentId));
}

/** A banner path is "<student id>/<uuid>.<ext>", under the student's own prefix. */
export function isOwnBannerPath(studentId: string, path: string): boolean {
  const [prefix, file, ...rest] = path.split("/");
  return rest.length === 0 && prefix === studentId && /^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(file ?? "");
}

/**
 * Save a preferences patch on the student's own client. The merged row is
 * checked here so the student hears why ("add a phone number first") rather
 * than a bare constraint error; the table's CHECKs are the backstop.
 */
export async function savePreferences(
  db: SupabaseClient,
  studentId: string,
  patch: PreferencesPatch
): Promise<StudentPreferences> {
  const current = await readRow(db, studentId);

  const next: Row = { ...current };
  if (patch.bannerPreset !== undefined) next.banner_preset = patch.bannerPreset;
  if (patch.theme !== undefined) next.theme = patch.theme;
  if (patch.showStrengthProfile !== undefined) next.show_strength_profile = patch.showStrengthProfile;
  if (patch.smsEnabled !== undefined) next.sms_enabled = patch.smsEnabled;
  if (patch.smsPhone !== undefined) next.sms_phone = patch.smsPhone;
  if (patch.emailEnabled !== undefined) next.email_enabled = patch.emailEnabled;
  if (patch.emailAddress !== undefined) next.email_address = patch.emailAddress;

  const oldPath = typeof current.banner_image_path === "string" ? current.banner_image_path : null;
  if (patch.bannerImagePath !== undefined) {
    if (patch.bannerImagePath !== null) {
      if (!isOwnBannerPath(studentId, patch.bannerImagePath)) {
        throw badRequest("Upload the banner through /me/preferences/banner-upload first");
      }
      // The object must exist and be readable by this student.
      if (!(await signedBannerUrl(db, patch.bannerImagePath))) {
        throw badRequest("That image hasn't finished uploading");
      }
    }
    next.banner_image_path = patch.bannerImagePath;
  }

  if (next.sms_enabled === true && !next.sms_phone) {
    throw badRequest("Add a phone number to get reminders by text");
  }
  if (next.email_enabled === true && !next.email_address) {
    throw badRequest("Add an email address to get reminders by email");
  }

  const { data, error } = await db
    .from("student_preferences")
    .upsert(
      {
        student_id: studentId,
        banner_preset: next.banner_preset,
        banner_image_path: next.banner_image_path ?? null,
        theme: next.theme,
        // Named only when the student changed it, so a database without the
        // column keeps saving everything else.
        ...(patch.showStrengthProfile !== undefined ? { show_strength_profile: patch.showStrengthProfile } : {}),
        sms_enabled: next.sms_enabled,
        sms_phone: next.sms_phone ?? null,
        email_enabled: next.email_enabled,
        email_address: next.email_address ?? null,
      },
      { onConflict: "student_id" }
    )
    .select("*")
    .single();
  if (error) {
    if (patch.showStrengthProfile !== undefined && isResultsNotApplied(error)) throw visibilityUnavailable();
    throw fromPostgrest(error);
  }

  // A replaced or cleared upload goes, best effort: the row no longer points
  // at it, and a stray object is only storage, never shown.
  const newPath = (data as Row).banner_image_path ?? null;
  if (oldPath && oldPath !== newPath) {
    await db.storage.from(BANNER_BUCKET).remove([oldPath]).catch(() => undefined);
  }

  return toDto(db, data as Row);
}

/**
 * A signed upload URL for a new banner image, minted on the student's own
 * token so the bucket's policies (their own prefix only) decide it. The
 * client uploads to it, then saves the returned path with PATCH.
 */
export async function bannerUploadUrl(
  db: SupabaseClient,
  studentId: string,
  contentType: keyof typeof BANNER_TYPES
) {
  const path = `${studentId}/${randomUUID()}.${BANNER_TYPES[contentType]}`;
  const { data, error } = await db.storage.from(BANNER_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw badRequest("Couldn't start the upload. Try again.");
  return {
    bucket: BANNER_BUCKET,
    path: data.path ?? path,
    signedUrl: data.signedUrl,
    token: data.token,
    contentType,
    maxBytes: BANNER_MAX_BYTES,
  };
}
