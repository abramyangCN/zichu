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
import type { ActivityWeather, StravaActivity, StravaStreams } from "../src/worker/types";

const activity: StravaActivity = {
  id: 42,
  name: "午后骑行",
  device_name: "Garmin Edge 840",
  gear_id: "b42",
  gear: { id: "b42", name: "Cinelli Pressure" },
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

const weather: ActivityWeather = {
  activityId: 42,
  observedAt: "2026-10-23T14:00",
  temperatureC: 18.2,
  apparentTemperatureC: 17.4,
  relativeHumidityPercent: 82,
  precipitationMm: 0.3,
  windSpeedKmh: 12.6,
  windDirectionDegrees: 45,
  weatherCode: 2,
  source: "open-meteo",
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
    expect(result.description).toContain("平均功率：200 W");
    expect(result.description).toContain("最大功率：200 W");
    expect(result.description).toContain("移动时间：01:30 h");
    expect(result.description).toContain("骑行记录 | Cinelli Pressure");
    expect(result.description).not.toContain("Garmin Edge 840");
  });

  it("includes optional cached weather with attribution", () => {
    const result = generateSummary(activity, streams, 250, weather, "Favero Assioma PRO RS-2");
    expect(result.description).toBe(`🚴 骑行记录 | Cinelli Pressure

🌤️ 天气信息 | Open-Meteo
☁️ Cool, partly cloudy
🌡️ 温度：18.2°C
🧍 体感温度：17.4°C
💨 风速：12.6 km/h
💧 湿度：82%

📊 骑行数据
📏 距离：40.1 km
⏱️ 移动时间：01:30 h
🚀 平均速度：26.7 km/h
⛰️ 累计爬升：328 m

⚡️ 功率表现 | Favero Assioma PRO RS-2
平均功率：200 W
最大功率：200 W

🫀 心率表现
平均心率：148 bpm
最大心率：181 bpm`);
    expect(result.weather).toEqual(weather);
  });

  it("omits the entire power section when power data is unavailable", () => {
    const result = generateSummary(activity, {}, 250);
    expect(result.description).not.toContain("功率表现");
    expect(result.description).not.toContain("平均功率");
    expect(result.description).not.toContain("最大功率");
  });
});

describe("mergeSummary", () => {
  it("preserves a user's existing description", () => {
    const result = mergeSummary("今天风很大", "测试摘要");
    expect(result).toBe("今天风很大\n\n测试摘要");
    expect(result).not.toContain(SUMMARY_START);
    expect(result).not.toContain(SUMMARY_END);
  });

  it("replaces a previously saved markerless summary", () => {
    const previous = "🚴 骑行记录\n\n旧摘要";
    const current = `我的备注\n\n${previous}`;
    const next = "🚴 骑行记录\n\n新摘要";
    expect(mergeSummary(current, next, previous)).toBe(`我的备注\n\n${next}`);
  });

  it("upgrades a legacy marked block without leaving visible comments", () => {
    const legacy = `我的备注\n\n${SUMMARY_START}\n旧摘要\n${SUMMARY_END}`;
    const result = mergeSummary(legacy, "🚴 骑行记录\n\n新摘要");
    expect(result).toBe("我的备注\n\n🚴 骑行记录\n\n新摘要");
    expect(result).not.toContain("<!--");
  });

  it("removes only the izchu block when an activity is no longer cycling", () => {
    const summary = "🚴 骑行记录\n\n骑行摘要";
    const withSummary = mergeSummary("保留我的备注", summary);
    expect(removeSummary(withSummary, summary)).toBe("保留我的备注");
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
