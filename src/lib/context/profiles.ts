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
    "awards", "courses", "testScores", "meetingNotes", "upcomingMeetings", "deadlines", "tasks", "polygon", "essays", "documents"] },
  "student-ai": { budget: 40_000, essayBodies: false, sections: ["profile", "academics", "personal", "activities",
    "awards", "courses", "testScores", "colleges", "essays", "intake", "documents"] },
  "narrative-coherence": { budget: 50_000, essayBodies: true, sections: ["profile", "personal", "essays", "activities", "awards"] },
  "college-list": { budget: 24_000, essayBodies: false, sections: ["academics", "personal", "testScores", "colleges",
    "activities", "awards", "courses", "profile"] },
  activities: { budget: 24_000, essayBodies: false, sections: ["personal", "activities", "awards", "academics",
    "courses", "testScores", "profile"] },
};
