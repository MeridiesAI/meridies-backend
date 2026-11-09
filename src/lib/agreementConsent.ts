/**
 * The consent wording a family sees next to the checkbox on the public
 * agreement page (routes/agreements.ts, GET /agree/:token), and its version.
 * The version is stored on every acceptance and printed on its certificate, so
 * changing the sentence means changing the version too.
 *
 * Agreements stay switched OFF (AGREEMENTS_ENABLED) until this wording has been
 * reviewed. This is typed-name acceptance, not a certified electronic signature.
 */

// NEEDS LEGAL REVIEW — placeholder wording, not approved
export const AGREEMENT_CONSENT_VERSION = "v0-PLACEHOLDER";

// NEEDS LEGAL REVIEW — placeholder wording, not approved
export const AGREEMENT_CONSENT_SENTENCE =
  "I have read the agreement above. By typing my full name and ticking this box, I agree to it, and I agree that my typed name counts as my acceptance.";
