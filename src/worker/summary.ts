import type {
  ActivityWeather,
  GeneratedSummary,
  StravaActivity,
  StravaStreams,
  SummaryMetrics,
} from "./types";
import { weatherSummary } from "./weather";

export const SUMMARY_START = "<!-- izchu:summary:start -->";
export const SUMMARY_END = "<!-- izchu:summary:end -->";
const SUMMARY_HEADING = "🚴 骑行记录";

const cyclingTypes = new Set([
  "Ride",
  "VirtualRide",
  "EBikeRide",
  "MountainBikeRide",
  "GravelRide",
  "Velomobile",
  "Handcycle",
]);

export function isCyclingActivity(activity: Pick<StravaActivity, "sport_type" | "type">): boolean {
  return cyclingTypes.has(activity.sport_type ?? activity.type ?? "");
}

function round(value: number, digits = 1): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function powerValues(streams: StravaStreams): number[] {
  const data = streams.watts?.data;
  if (!Array.isArray(data)) return [];
  return data.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

export function normalizedPower(values: number[], windowSize = 30): number | null {
  if (values.length < windowSize) return null;
  let rollingTotal = values.slice(0, windowSize).reduce((total, value) => total + value, 0);
  let fourthPowerTotal = (rollingTotal / windowSize) ** 4;
  let samples = 1;
  for (let index = windowSize; index < values.length; index += 1) {
    rollingTotal += values[index] - values[index - windowSize];
    fourthPowerTotal += (rollingTotal / windowSize) ** 4;
    samples += 1;
  }
  return Math.round((fourthPowerTotal / samples) ** 0.25);
}

export function buildMetrics(
  activity: StravaActivity,
  streams: StravaStreams,
  ftp: number | null,
): SummaryMetrics {
  const powers = powerValues(streams);
  const np = normalizedPower(powers) ?? activity.weighted_average_watts ?? null;
  const averagePower =
    activity.average_watts ??
    (powers.length ? powers.reduce((total, value) => total + value, 0) / powers.length : null);
  const maxPower = activity.max_watts ?? (powers.length ? Math.max(...powers) : null);
  const intensityFactor = np && ftp ? np / ftp : null;
  const trainingStressScore =
    np && ftp && intensityFactor
      ? (activity.moving_time * np * intensityFactor * 100) / (ftp * 3600)
      : null;
  return {
    distanceKm: round(activity.distance / 1000),
    movingMinutes: Math.round(activity.moving_time / 60),
    elevationGain: Math.round(activity.total_elevation_gain),
    averageSpeedKmh: activity.average_speed ? round(activity.average_speed * 3.6) : null,
    averagePower: averagePower === null ? null : Math.round(averagePower),
    maxPower: maxPower === null ? null : Math.round(maxPower),
    normalizedPower: np ? Math.round(np) : null,
    intensityFactor: intensityFactor ? round(intensityFactor, 2) : null,
    trainingStressScore: trainingStressScore ? Math.round(trainingStressScore) : null,
    averageHeartRate: activity.average_heartrate ? Math.round(activity.average_heartrate) : null,
    maxHeartRate: activity.max_heartrate ? Math.round(activity.max_heartrate) : null,
    averageCadence: activity.average_cadence ? Math.round(activity.average_cadence) : null,
    workKilojoules: activity.kilojoules ? Math.round(activity.kilojoules) : null,
  };
}

function duration(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function generateSummary(
  activity: StravaActivity,
  streams: StravaStreams,
  ftp: number | null,
  weather: ActivityWeather | null = null,
  powerMeterName: string | null = null,
): GeneratedSummary {
  const metrics = buildMetrics(activity, streams, ftp);
  const bikeName = activity.gear?.name?.trim();
  const sections = [bikeName ? `${SUMMARY_HEADING} | ${bikeName}` : SUMMARY_HEADING];
  if (weather) sections.push(weatherSummary(weather));

  sections.push(
    [
      "📊 骑行数据",
      `📏 距离：${metrics.distanceKm} km`,
      `⏱️ 移动时间：${duration(metrics.movingMinutes)} h`,
      metrics.averageSpeedKmh === null ? null : `🚀 平均速度：${metrics.averageSpeedKmh} km/h`,
      `⛰️ 累计爬升：${metrics.elevationGain} m`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const power = [
    powerMeterName?.trim()
      ? `⚡️ 功率表现 | ${powerMeterName.trim()}`
      : "⚡️ 功率表现",
    metrics.averagePower === null ? null : `平均功率：${metrics.averagePower} W`,
    metrics.maxPower === null ? null : `最大功率：${metrics.maxPower} W`,
  ].filter(Boolean);
  if (power.length > 1) sections.push(power.join("\n"));

  const heartRate = [
    "🫀 心率表现",
    metrics.averageHeartRate === null ? null : `平均心率：${metrics.averageHeartRate} bpm`,
    metrics.maxHeartRate === null ? null : `最大心率：${metrics.maxHeartRate} bpm`,
  ].filter(Boolean);
  if (heartRate.length > 1) sections.push(heartRate.join("\n"));
  return {
    activityId: activity.id,
    activityName: activity.name,
    description: sections.join("\n\n"),
    metrics,
    weather,
    source: "strava",
  };
}

function legacyBlockRange(current: string): { start: number; end: number } | null {
  const start = current.indexOf(SUMMARY_START);
  const markerEnd = current.indexOf(SUMMARY_END, start + SUMMARY_START.length);
  if (start < 0 || markerEnd < start) return null;
  return { start, end: markerEnd + SUMMARY_END.length };
}

function markerlessSummaryStart(current: string): number {
  if (current.startsWith(SUMMARY_HEADING)) return 0;
  const start = current.lastIndexOf(`\n\n${SUMMARY_HEADING}`);
  return start < 0 ? -1 : start + 2;
}

function replaceRange(current: string, start: number, end: number, replacement: string): string {
  const before = current.slice(0, start).trimEnd();
  const after = current.slice(end).trimStart();
  return [before, replacement.trim(), after].filter(Boolean).join("\n\n");
}

export function mergeSummary(
  existing: string | null | undefined,
  summary: string,
  previousSummary: string | null = null,
): string {
  const next = summary.trim();
  const current = (existing ?? "").trim();
  const legacy = legacyBlockRange(current);
  if (legacy) return replaceRange(current, legacy.start, legacy.end, next);

  const previous = previousSummary?.trim();
  if (previous) {
    const start = current.indexOf(previous);
    if (start >= 0) return replaceRange(current, start, start + previous.length, next);
  }

  const start = markerlessSummaryStart(current);
  if (start >= 0) return replaceRange(current, start, current.length, next);
  return current ? `${current}\n\n${next}` : next;
}

export function removeSummary(
  existing: string | null | undefined,
  previousSummary: string | null = null,
): string {
  const current = (existing ?? "").trim();
  const legacy = legacyBlockRange(current);
  if (legacy) return replaceRange(current, legacy.start, legacy.end, "");

  const previous = previousSummary?.trim();
  if (previous) {
    const start = current.indexOf(previous);
    if (start >= 0) return replaceRange(current, start, start + previous.length, "");
  }

  const start = markerlessSummaryStart(current);
  return start >= 0 ? replaceRange(current, start, current.length, "") : current;
}
