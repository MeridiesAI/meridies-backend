/** Time saved (monthly ROI report): the task types the ledger counts. */
export const TASK_TYPES = ["college_list", "essay_feedback", "meeting", "family_report", "activity_list"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Postgres / PostgREST codes meaning the feature's migration isn't applied yet. */
export const KPI_SCHEMA_MISSING = new Set(["42P01", "42883", "42703", "PGRST202", "PGRST205", "PGRST204"]);
