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
  studentName: string | null;
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
