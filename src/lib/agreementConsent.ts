/**
 * The consent wording a family sees next to the checkbox on the public
 * agreement page (routes/agreements.ts, GET /agree/:token), and its version.
 * The version is stored on every acceptance and printed on its certificate, so
 * changing the sentence means changing the version too.
 *
 * Legal review approved this wording on 2026-11-11 (v1). Agreements are on only
 * with AGREEMENTS_ENABLED=true. This is typed-name acceptance, not a certified
 * electronic signature.
 */

// Reviewed 2026-11-11. A new sentence needs a new version.
export const AGREEMENT_CONSENT_VERSION = "v1-2026-11-11";

export const AGREEMENT_CONSENT_SENTENCE =
  "I have read the agreement above. By typing my full name and ticking this box, I agree to it, and I agree that my typed name counts as my acceptance.";
