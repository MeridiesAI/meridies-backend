/** Time saved: the default figures (unedited = "estimated") and the baselines DTO. */
import { TASK_TYPES, type TaskType } from "./types.js";

export const DEFAULT_BASELINES: Record<TaskType, { manual: number; meridies: number }> = {
  college_list: { manual: 240, meridies: 30 },
  essay_feedback: { manual: 45, meridies: 15 },
  meeting: { manual: 45, meridies: 15 },
  family_report: { manual: 60, meridies: 10 },
  activity_list: { manual: 90, meridies: 20 },
};
export const DEFAULT_RATE = 150;
export const DEFAULT_HOURS_PER_STUDENT = 40;

export type BaselinesRow = {
  manual: Record<string, unknown>;
  meridies: Record<string, unknown>;
  manual_edited: Record<string, unknown>;
  meridies_edited: Record<string, unknown>;
  hourly_rate: string | number | null;
  rate_edited: boolean;
  hours_per_student_year: string | number | null;
  hours_edited: boolean;
  monthly_email: boolean;
  prompt_dismissed_at: string | null;
};

export type TaskBaseline = { manual: number; meridies: number; manualEdited: boolean; meridiesEdited: boolean };
export type BaselinesDto = {
  tasks: Record<TaskType, TaskBaseline>;
  hourlyRate: number;
  rateEdited: boolean;
  hoursPerStudentYear: number;
  hoursEdited: boolean;
  monthlyEmail: boolean;
  needsPrompt: boolean;
};

const num = (v: unknown, fallback: number) => (v === null || v === undefined || Number.isNaN(Number(v)) ? fallback : Number(v));

export function toBaselinesDto(row: BaselinesRow | null): BaselinesDto {
  const tasks = Object.fromEntries(
    TASK_TYPES.map((t) => [
      t,
      {
        manual: num(row?.manual?.[t], DEFAULT_BASELINES[t].manual),
        meridies: num(row?.meridies?.[t], DEFAULT_BASELINES[t].meridies),
        manualEdited: row?.manual_edited?.[t] === true,
        meridiesEdited: row?.meridies_edited?.[t] === true,
      },
    ])
  ) as Record<TaskType, TaskBaseline>;
  return {
    tasks,
    hourlyRate: num(row?.hourly_rate, DEFAULT_RATE),
    rateEdited: row?.rate_edited === true,
    hoursPerStudentYear: num(row?.hours_per_student_year, DEFAULT_HOURS_PER_STUDENT),
    hoursEdited: row?.hours_edited === true,
    monthlyEmail: row ? row.monthly_email !== false : true,
    needsPrompt: row === null,
  };
}
