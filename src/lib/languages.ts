/**
 * The languages a family can be written to in (Communication › Translate).
 *
 * One closed list, shared by the demo, the app and the backend (the same file,
 * copied): the language a counselor picks is a code from here, never free
 * text, so nothing a student typed can reach a translation prompt. `en` means
 * "no translation": the family reads English.
 *
 * `home_language` on Financial aid is a free-text name ("Mandarin"); that
 * stays as it is, and `languageFromName` reads one back to a code.
 */

export type LanguageCode =
  | "es"
  | "zh"
  | "zh-Hant"
  | "vi"
  | "tl"
  | "ar"
  | "ko"
  | "hi"
  | "pt"
  | "ru"
  | "fr"
  | "ht"
  | "ur"
  | "bn"
  | "fa"
  | "pl";

/** A choice in the picker: a language, or `en` for "English only". */
export type FamilyLanguageChoice = LanguageCode | "en";

export type FamilyLanguage = {
  code: LanguageCode;
  /** In English, for the counselor. */
  name: string;
  /** In the language itself, so a counselor can check they picked the right one. */
  native: string;
  /** Written right to left: the email wraps each paragraph with dir="auto". */
  rtl: boolean;
};

export const FAMILY_LANGUAGES: readonly FamilyLanguage[] = [
  { code: "es", name: "Spanish", native: "Español", rtl: false },
  { code: "zh", name: "Chinese (Simplified)", native: "简体中文", rtl: false },
  { code: "zh-Hant", name: "Chinese (Traditional)", native: "繁體中文", rtl: false },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", rtl: false },
  { code: "tl", name: "Tagalog", native: "Tagalog", rtl: false },
  { code: "ar", name: "Arabic", native: "العربية", rtl: true },
  { code: "ko", name: "Korean", native: "한국어", rtl: false },
  { code: "hi", name: "Hindi", native: "हिन्दी", rtl: false },
  { code: "pt", name: "Portuguese", native: "Português", rtl: false },
  { code: "ru", name: "Russian", native: "Русский", rtl: false },
  { code: "fr", name: "French", native: "Français", rtl: false },
  { code: "ht", name: "Haitian Creole", native: "Kreyòl ayisyen", rtl: false },
  { code: "ur", name: "Urdu", native: "اردو", rtl: true },
  { code: "bn", name: "Bengali", native: "বাংলা", rtl: false },
  { code: "fa", name: "Persian (Farsi)", native: "فارسی", rtl: true },
  { code: "pl", name: "Polish", native: "Polski", rtl: false },
];

const BY_CODE = new Map<string, FamilyLanguage>(FAMILY_LANGUAGES.map((l) => [l.code, l]));

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && BY_CODE.has(value);
}

export function isLanguageChoice(value: unknown): value is FamilyLanguageChoice {
  return value === "en" || isLanguageCode(value);
}

export function languageByCode(code: LanguageCode): FamilyLanguage {
  // The map is built from the same list the type comes from.
  return BY_CODE.get(code) as FamilyLanguage;
}

/** "Spanish", or "English" for `en`. */
export function languageName(code: FamilyLanguageChoice): string {
  return code === "en" ? "English" : languageByCode(code).name;
}

/**
 * The short name a sentence uses ("Translate to Spanish", "Replies look like
 * Chinese"): the same as `languageName`, without the script in brackets.
 */
export function languageShortName(code: FamilyLanguageChoice): string {
  return languageName(code).replace(/\s*\(.*\)$/, "");
}

export function isRtl(code: FamilyLanguageChoice): boolean {
  return code !== "en" && languageByCode(code).rtl;
}

const NAME_TO_CODE: Record<string, LanguageCode> = {
  spanish: "es",
  español: "es",
  espanol: "es",
  mandarin: "zh",
  chinese: "zh",
  "chinese (simplified)": "zh",
  cantonese: "zh-Hant",
  "chinese (traditional)": "zh-Hant",
  vietnamese: "vi",
  tagalog: "tl",
  filipino: "tl",
  arabic: "ar",
  korean: "ko",
  hindi: "hi",
  portuguese: "pt",
  russian: "ru",
  french: "fr",
  "haitian creole": "ht",
  creole: "ht",
  urdu: "ur",
  bengali: "bn",
  bangla: "bn",
  persian: "fa",
  farsi: "fa",
  "persian (farsi)": "fa",
  polish: "pl",
};

/**
 * Financial aid keeps the family's home language as a name the counselor
 * picked or typed. A name on the list becomes its code; anything else
 * ("Other", "English", a language not offered) is null.
 */
export function languageFromName(name: string | null | undefined): LanguageCode | null {
  const key = (name ?? "").trim().toLowerCase();
  return NAME_TO_CODE[key] ?? null;
}
