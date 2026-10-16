export type ContextUsage = {
  used: { section: string; items?: string[] }[];
  omitted: {
    section: string;
    reason: "budget" | "not-allowed" | "not-categorized" | "practice-setting" | "empty";
    count?: number;
  }[];
};

export type StudentContext = ContextUsage & {
  text: string;
  /**
   * The used sections that carry text someone other than the counselor wrote (OUTSIDE_SECTIONS,
   * tasks judged per row). Empty for a trustedOnly build. Never sent to a client.
   */
  outside: string[];
  studentName: string | null;
  /** Untrusted student text (names, schools, hometown): wrap with wrapUntrusted before it enters a prompt. */
  facts: {
    intendedMajors: string[];
    gradYear: string | null;
    state: string | null;
    gpa: { value: number | null; scale: string | null };
    sat: number | null;
    act: number | null;
    activityCategories: string[];
    identity: { name: string | null; email: string | null; school: string | null; hometown: string | null };
  };
};
