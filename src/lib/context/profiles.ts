import type { AllowTable } from "./ai-allowlist.js";

export type Feature = "chat" | "student-ai" | "narrative-coherence" | "college-list" | "activities";
export type SectionName =
  | "profile" | "academics" | "personal" | "activities" | "awards" | "courses" | "testScores" | "colleges"
  | "intake" | "meetingNotes" | "upcomingMeetings" | "deadlines" | "polygon" | "tasks" | "essays" | "documents";

export const SECTION_TABLES: Record<SectionName, AllowTable[]> = {
  profile: ["profiles"], academics: ["student_academics"], personal: ["student_personal_details"],
  activities: ["activities"], awards: ["awards"], courses: ["courses"], testScores: ["test_scores"],
  colleges: ["student_colleges"], intake: ["intake_responses"], meetingNotes: ["meeting_notes"],
  upcomingMeetings: ["meetings"], deadlines: ["deadlines"], polygon: ["student_polygon_axes"],
  tasks: ["deliverables"], essays: ["essays"], documents: ["documents"],
};

/** Sections are listed in priority order: when the budget runs out, the later ones are dropped whole. */
export const PROFILES: Record<Feature, { budget: number; sections: SectionName[]; essayBodies: boolean }> = {
  chat: { budget: 60_000, essayBodies: false, sections: ["profile", "academics", "personal", "colleges", "activities",
    "awards", "courses", "testScores", "meetingNotes", "upcomingMeetings", "deadlines", "tasks", "polygon", "essays", "intake", "documents"] },
  "student-ai": { budget: 40_000, essayBodies: false, sections: ["profile", "academics", "personal", "activities",
    "awards", "courses", "testScores", "colleges", "essays", "intake", "documents"] },
  "narrative-coherence": { budget: 50_000, essayBodies: true, sections: ["profile", "personal", "essays", "activities", "awards"] },
  "college-list": { budget: 24_000, essayBodies: false, sections: ["academics", "personal", "testScores", "colleges",
    "activities", "awards", "courses", "profile"] },
  activities: { budget: 24_000, essayBodies: false, sections: ["personal", "activities", "awards", "academics",
    "courses", "testScores", "profile"] },
};

/**
 * Sections whose text someone other than the counselor may have written: the
 * student (every attach_student_policies table, their own profile fields, the
 * tasks and deadlines they add, intake answers), Profile Update's AI rows, an
 * import, the questionnaire, or an uploaded file. AxIS treats a turn that read
 * any of them as having read outside content (lib/axis/ops/run.ts), so text in
 * them can't make a change happen without the counselor's click.
 *
 * Not on it, because only counselors write them: meeting notes, meetings, and
 * the strength profile (counselor-only since 20261010). Tasks are judged per
 * row (a student's own task is theirs; a counselor's task title the student
 * can't change), and a `trustedOnly` build keeps the profile to the name and
 * class year (see buildStudentContext).
 */
export const OUTSIDE_SECTIONS: ReadonlySet<SectionName> = new Set<SectionName>([
  "profile", "academics", "personal", "activities", "awards", "courses", "testScores", "colleges",
  "intake", "deadlines", "tasks", "essays", "documents",
]);

/** Sections a counselor alone writes, plus the trusted forms of profile and tasks: what an AxIS change turn reads. */
export const TRUSTED_SECTIONS: readonly SectionName[] = ["profile", "upcomingMeetings", "meetingNotes", "polygon", "tasks"];
