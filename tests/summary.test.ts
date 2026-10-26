import { describe, expect, it } from "vitest";
import {
  generateSummary,
  isCyclingActivity,
  mergeSummary,
  normalizedPower,
  removeSummary,
  SUMMARY_END,
  SUMMARY_START,
} from "../src/worker/summary";
import type { StravaActivity, StravaStreams } from "../src/worker/types";

const activity: StravaActivity = {
  id: 42,
  name: "午后骑行",
  start_date_local: "2026-10-23T14:00:00+08:00",
  distance: 40_120,
  moving_time: 5_400,
  elapsed_time: 5_700,
  total_elevation_gain: 328,
  average_speed: 7.43,
  average_heartrate: 148,
  max_heartrate: 181,
  average_cadence: 86,
  kilojoules: 830,
};

const streams: StravaStreams = {
  watts: { type: "watts", data: Array.from({ length: 90 }, () => 200), original_size: 90, resolution: "high" },
};

describe("normalizedPower", () => {
  it("returns the steady power for a steady effort", () => {
    expect(normalizedPower(Array.from({ length: 120 }, () => 225))).toBe(225);
  });

  it("returns null when there are not enough samples", () => {
    expect(normalizedPower([200, 210])).toBeNull();
  });
});

describe("generateSummary", () => {
  it("calculates training metrics when FTP is configured", () => {
    const result = generateSummary(activity, streams, 250);
    expect(result.metrics.normalizedPower).toBe(200);
    expect(result.metrics.intensityFactor).toBe(0.8);
    expect(result.metrics.trainingStressScore).toBe(96);
    expect(result.description).toContain("40.1 km");
    expect(result.description).toContain("NP 200 W");
  });
});

describe("mergeSummary", () => {
  it("preserves a user's existing description", () => {
    const result = mergeSummary("今天风很大", "测试摘要");
    expect(result).toContain("今天风很大");
    expect(result).toContain(SUMMARY_START);
    expect(result).toContain(SUMMARY_END);
  });

  it("replaces only the previous izchu block", () => {
    const first = mergeSummary("我的备注", "旧摘要");
    const second = mergeSummary(first, "新摘要");
    expect(second).toContain("我的备注");
    expect(second).not.toContain("旧摘要");
    expect(second.match(new RegExp(SUMMARY_START, "g"))).toHaveLength(1);
  });

  it("removes only the izchu block when an activity is no longer cycling", () => {
    const withSummary = mergeSummary("保留我的备注", "骑行摘要");
    expect(removeSummary(withSummary)).toBe("保留我的备注");
  });
});

describe("isCyclingActivity", () => {
  it("accepts Strava cycling sport types", () => {
    expect(isCyclingActivity({ sport_type: "Ride" })).toBe(true);
    expect(isCyclingActivity({ sport_type: "GravelRide" })).toBe(true);
    expect(isCyclingActivity({ sport_type: "VirtualRide" })).toBe(true);
  });

  it("rejects non-cycling activities", () => {
    expect(isCyclingActivity({ sport_type: "Swim" })).toBe(false);
    expect(isCyclingActivity({ sport_type: "Run" })).toBe(false);
  });
});
