/**
 * Labels for the coded College Scorecard / IPEDS fields college_stats keeps.
 * Pure, and null for any code not listed, so a new code shows as unlabelled
 * rather than as the wrong thing. The texts are the value labels of the
 * Scorecard data dictionary (CCSIZSET, CCBASIC: the Carnegie Classification's
 * 2015 scheme and its 2018/2021 updates, which Scorecard uses; PREDDEG).
 *
 * Locale is not here: settingFromLocale (lib/collegesV10.ts) maps it to the
 * campus-setting words the curated profiles and the list builder already use,
 * so one page never mixes two vocabularies. Test requirements are not here
 * either: they are the IPEDS admission-consideration codes, read with
 * consideration/testPolicyFrom (lib/ingest/ipeds.ts).
 */

const CARNEGIE_SIZE_SETTING: Record<number, string> = {
  1: "Two-year, very small",
  2: "Two-year, small",
  3: "Two-year, medium",
  4: "Two-year, large",
  5: "Two-year, very large",
  6: "Four-year, very small, primarily nonresidential",
  7: "Four-year, very small, primarily residential",
  8: "Four-year, very small, highly residential",
  9: "Four-year, small, primarily nonresidential",
  10: "Four-year, small, primarily residential",
  11: "Four-year, small, highly residential",
  12: "Four-year, medium, primarily nonresidential",
  13: "Four-year, medium, primarily residential",
  14: "Four-year, medium, highly residential",
  15: "Four-year, large, primarily nonresidential",
  16: "Four-year, large, primarily residential",
  17: "Four-year, large, highly residential",
  18: "Exclusively graduate/professional",
};

const CARNEGIE_BASIC: Record<number, string> = {
  1: "Associate's Colleges: High Transfer-High Traditional",
  2: "Associate's Colleges: High Transfer-Mixed Traditional/Nontraditional",
  3: "Associate's Colleges: High Transfer-High Nontraditional",
  4: "Associate's Colleges: Mixed Transfer/Career & Technical-High Traditional",
  5: "Associate's Colleges: Mixed Transfer/Career & Technical-Mixed Traditional/Nontraditional",
  6: "Associate's Colleges: Mixed Transfer/Career & Technical-High Nontraditional",
  7: "Associate's Colleges: High Career & Technical-High Traditional",
  8: "Associate's Colleges: High Career & Technical-Mixed Traditional/Nontraditional",
  9: "Associate's Colleges: High Career & Technical-High Nontraditional",
  10: "Special Focus Two-Year: Health Professions",
  11: "Special Focus Two-Year: Technical Professions",
  12: "Special Focus Two-Year: Arts & Design",
  13: "Special Focus Two-Year: Other Fields",
  14: "Baccalaureate/Associate's Colleges: Associate's Dominant",
  15: "Doctoral Universities: Very High Research Activity",
  16: "Doctoral Universities: High Research Activity",
  17: "Doctoral/Professional Universities",
  18: "Master's Colleges & Universities: Larger Programs",
  19: "Master's Colleges & Universities: Medium Programs",
  20: "Master's Colleges & Universities: Small Programs",
  21: "Baccalaureate Colleges: Arts & Sciences Focus",
  22: "Baccalaureate Colleges: Diverse Fields",
  23: "Baccalaureate/Associate's Colleges: Mixed Baccalaureate/Associate's",
  24: "Special Focus Four-Year: Faith-Related Institutions",
  25: "Special Focus Four-Year: Medical Schools & Centers",
  26: "Special Focus Four-Year: Other Health Professions Schools",
  27: "Special Focus Four-Year: Engineering Schools",
  28: "Special Focus Four-Year: Other Technology-Related Schools",
  29: "Special Focus Four-Year: Business & Management Schools",
  30: "Special Focus Four-Year: Arts, Music & Design Schools",
  31: "Special Focus Four-Year: Law Schools",
  32: "Special Focus Four-Year: Other Special Focus Institutions",
  33: "Tribal Colleges",
};

/** PREDDEG: the level most of the school's undergraduate awards are at. */
const PREDOMINANT_DEGREE: Record<number, string> = {
  1: "Certificate",
  2: "Associate's",
  3: "Bachelor's",
  4: "Graduate only",
};

const label = (table: Record<number, string>) => (code: number | null | undefined): string | null =>
  code == null || !Number.isInteger(code) ? null : (table[code] ?? null);

export const carnegieSizeSettingLabel = label(CARNEGIE_SIZE_SETTING);
export const carnegieBasicLabel = label(CARNEGIE_BASIC);
export const predominantDegreeLabel = label(PREDOMINANT_DEGREE);

/** RELAFFIL: -1 not reported and -2 not applicable; any positive code is a denomination. */
export function isReligiouslyAffiliated(code: number | null | undefined): boolean {
  return code != null && Number.isInteger(code) && code > 0;
}

/**
 * What the two completion figures measure, which depends on the IPEDS cohort
 * they came from (college_stats.completion_basis). A less-than-four-year
 * school's 150% window depends on its programs (3 years for a 2-year degree),
 * so it is never called a number of years.
 */
export function completionLabels(basis: string | null | undefined): { onTime: string | null; within150: string | null } {
  if (basis === "four-year") return { onTime: "Graduated within 4 years", within150: "Graduated within 6 years" };
  if (basis === "less-than-four-year") return { onTime: "Finished within normal time", within150: "Finished within 150% of normal time" };
  return { onTime: null, within150: null };
}
