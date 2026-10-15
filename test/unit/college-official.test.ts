import assert from "node:assert/strict";
import { test } from "node:test";
import { toOfficialStats } from "../../src/lib/collegesV10.js";
import { failingAlerts, isFailing, summarizeHeartbeats } from "../../src/lib/heartbeat.js";
import {
  carnegieBasicLabel,
  carnegieSizeSettingLabel,
  completionLabels,
  isReligiouslyAffiliated,
  predominantDegreeLabel,
} from "../../src/lib/scorecardCodes.js";

const NOW = Date.parse("2026-10-15T00:00:00Z");

/** A college_stats row as it stood before migration 20261023080001. */
const before = {
  college_id: "c1",
  unitid: 110635,
  admit_rate: "0.1150",
  open_admissions: false,
  test_requirements: 3,
  sat_ebrw_25: 640,
  sat_ebrw_75: 740,
  sat_math_25: 650,
  sat_math_75: 790,
  sat_total_25: 1290,
  sat_total_75: 1530,
  act_25: 29,
  act_75: 35,
  undergrad_enrollment: 32831,
  control: "public",
  predominant_degree: 3,
  locale: 12,
  carnegie_size_setting: 16,
  religious_affiliation: -2,
  hbcu: false,
  hsi: true,
  tribal: false,
  women_only: false,
  men_only: false,
  cost_of_attendance: 42000,
  tuition_in_state: 14850,
  tuition_out_of_state: 44000,
  avg_net_price: 15000,
  net_price_by_income: { "0-30000": 8697 },
  price_calculator_url: "https://example.edu/npc",
  pell_rate: "0.2500",
  federal_loan_rate: "0.1800",
  median_debt: 12000,
  grad_rate: "0.9428",
  median_earnings_10yr: 92446,
  data_year: "Scorecard latest",
  source_url: "https://collegescorecard.ed.gov/school/?110635",
  source_verified_at: "2026-10-07T00:00:00Z",
};

test("official stats: a row from before the migration serves every new key empty, the old ones unchanged", () => {
  const o = toOfficialStats(before, NOW);
  assert.equal(o.admitRate, 0.115);
  assert.deepEqual(o.satRange, { p25: 1290, p75: 1530 });
  assert.equal(o.gradRate, 0.9428);
  assert.equal(o.locale, 12);
  assert.equal(o.religiousAffiliation, -2);
  assert.equal(o.stale, false);
  for (const k of [
    "completionBasis", "gradRateOnTime", "gradRate150", "retentionRate", "partTimeShare", "studentFacultyRatio",
    "gradStudents", "roomBoardOnCampus", "booksSupplies", "medianEarnings6yr", "medianDebtMonthly",
    "medianDebtNoncompleters", "carnegieBasic",
  ] as const) {
    assert.equal(o[k], null, k);
  }
  assert.ok(Object.values(o.completionByRace).every((v) => v === null));
  assert.equal(o.demographics.women, null);
  assert.ok(Object.values(o.demographics.race).every((v) => v === null));
  assert.equal(Object.keys(o.demographics.race).length, 9);
  // Codes it always had, now labelled.
  assert.equal(o.testRequirements, 3);
  assert.equal(o.predominantDegree, 3);
  assert.equal(o.carnegieSizeSetting, 16);
  assert.equal(o.religious, false);
  assert.deepEqual(o.labels, {
    setting: "Small city",
    carnegieSizeSetting: "Four-year, large, primarily residential",
    carnegieBasic: null,
    testPolicy: "blind",
    predominantDegree: "Bachelor's",
    gradRateOnTime: null,
    gradRate150: null,
  });
});

test("official stats: the extended columns, read defensively", () => {
  const o = toOfficialStats(
    {
      ...before,
      test_requirements: 5,
      religious_affiliation: 30,
      carnegie_basic: 15,
      completion_basis: "four-year",
      grad_rate_on_time: "0.7612",
      grad_rate_150: "0.9317",
      completion_by_race: { asian: 0.95, white: "0.9", black: 2, hispanic: null },
      retention_rate: "0.9672",
      part_time_share: "0.0251",
      student_faculty_ratio: 19,
      grad_students: 12847,
      demographics: { women: 0.55, men: 0.45, asian: 0.35 },
      room_board_on_campus: 21245,
      books_supplies: 1336,
      median_earnings_6yr: 71102,
      median_debt_monthly: 146,
      median_debt_noncompleters: 4500,
      source_verified_at: "2024-01-01T00:00:00Z",
    },
    NOW
  );
  assert.equal(o.completionBasis, "four-year");
  assert.equal(o.gradRate150, 0.9317);
  assert.equal(o.labels.gradRate150, "Graduated within 6 years");
  assert.equal(o.labels.gradRateOnTime, "Graduated within 4 years");
  assert.equal(o.completionByRace.asian, 0.95);
  assert.equal(o.completionByRace.white, null, "a string is not a share");
  assert.equal(o.completionByRace.black, null, "over 1 is not a share");
  assert.equal(o.demographics.women, 0.55);
  assert.equal(o.demographics.race.asian, 0.35);
  assert.equal(o.retentionRate, 0.9672);
  assert.equal(o.studentFacultyRatio, 19);
  assert.equal(o.medianDebtMonthly, 146);
  assert.equal(o.religious, true);
  assert.equal(o.labels.testPolicy, "optional");
  assert.equal(o.labels.carnegieBasic, "Doctoral Universities: Very High Research Activity");
  assert.equal(o.stale, true);
});

test("official stats: a two-year school is never labelled in years", () => {
  const o = toOfficialStats({ ...before, completion_basis: "less-than-four-year", grad_rate_150: 0.31, predominant_degree: 2 }, NOW);
  assert.equal(o.labels.gradRate150, "Finished within 150% of normal time");
  assert.equal(o.labels.predominantDegree, "Associate's");
  assert.equal(toOfficialStats({ ...before, completion_basis: "six-year" }, NOW).completionBasis, null);
  assert.equal(toOfficialStats({ ...before, demographics: [0.5] }, NOW).demographics.women, null);
});

test("Scorecard code labels: known codes, and null for the rest", () => {
  assert.equal(carnegieSizeSettingLabel(1), "Two-year, very small");
  assert.equal(carnegieSizeSettingLabel(18), "Exclusively graduate/professional");
  assert.equal(carnegieSizeSettingLabel(-2), null);
  assert.equal(carnegieSizeSettingLabel(19), null);
  assert.equal(carnegieBasicLabel(21), "Baccalaureate Colleges: Arts & Sciences Focus");
  assert.equal(carnegieBasicLabel(33), "Tribal Colleges");
  assert.equal(carnegieBasicLabel(0), null);
  assert.equal(carnegieBasicLabel(null), null);
  assert.equal(carnegieBasicLabel(15.5), null);
  assert.equal(predominantDegreeLabel(4), "Graduate only");
  assert.equal(predominantDegreeLabel(0), null);
  assert.equal(isReligiouslyAffiliated(30), true);
  assert.equal(isReligiouslyAffiliated(-1), false);
  assert.equal(isReligiouslyAffiliated(null), false);
  assert.deepEqual(completionLabels(null), { onTime: null, within150: null });
});

test("heartbeats: a degraded or failed last run is failing, and alerts at once for a monthly job", () => {
  assert.equal(isFailing("2026-10-01T00:00:00Z", null), false);
  assert.equal(isFailing("2026-10-01T00:00:00Z", "2026-09-01T00:00:00Z"), false);
  assert.equal(isFailing("2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"), true);
  assert.equal(isFailing(null, "2026-10-01T00:00:00Z"), true);
  assert.equal(failingAlerts("31 days"), true);
  assert.equal(failingAlerts("7 days"), true);
  assert.equal(failingAlerts("00:15:00"), false);
});

test("status: a failing monthly job turns it, a failing frequent one is only listed", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const fresh = "2026-10-15T11:55:00Z";
  const clean = [
    { job: "accountability-sweep", last_ok_at: fresh, last_error_at: null, expected_every: "00:15:00" },
    { job: "scorecard-ingest", last_ok_at: "2026-10-01T00:00:00Z", last_error_at: null, expected_every: "31 days" },
  ];
  assert.equal(summarizeHeartbeats(clean, now).status, "all-ok");
  const degraded = [clean[0]!, { ...clean[1]!, last_error_at: "2026-10-15T00:00:00Z" }];
  const d = summarizeHeartbeats(degraded, now);
  assert.equal(d.status, "failing");
  assert.deepEqual(d.failing, ["scorecard-ingest"]);
  assert.deepEqual(d.overdue, []);
  const blip = [{ ...clean[0]!, last_error_at: "2026-10-15T11:58:00Z" }, clean[1]!];
  const b = summarizeHeartbeats(blip, now);
  assert.equal(b.status, "all-ok");
  assert.deepEqual(b.failing, ["accountability-sweep"]);
  const late = [{ ...clean[0]!, last_ok_at: "2026-10-15T10:00:00Z" }, ...degraded.slice(1)];
  assert.equal(summarizeHeartbeats(late, now).status, "overdue");
});
