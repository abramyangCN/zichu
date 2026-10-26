import type { GeneratedSummary, StravaActivity, StravaStreams, SummaryMetrics } from "./types";

export const SUMMARY_START = "<!-- izchu:summary:start -->";
export const SUMMARY_END = "<!-- izchu:summary:end -->";

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
  const np = normalizedPower(powerValues(streams)) ?? activity.weighted_average_watts ?? null;
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
    normalizedPower: np ? Math.round(np) : null,
    intensityFactor: intensityFactor ? round(intensityFactor, 2) : null,
    trainingStressScore: trainingStressScore ? Math.round(trainingStressScore) : null,
    averageHeartRate: activity.average_heartrate ? Math.round(activity.average_heartrate) : null,
    maxHeartRate: activity.max_heartrate ? Math.round(activity.max_heartrate) : null,
    averageCadence: activity.average_cadence ? Math.round(activity.average_cadence) : null,
    workKilojoules: activity.kilojoules ? Math.round(activity.kilojoules) : null,
  };
}

export function generateSummary(
  activity: StravaActivity,
  streams: StravaStreams,
  ftp: number | null,
): GeneratedSummary {
  const metrics = buildMetrics(activity, streams, ftp);
  const lines = [
    `🚴 ${metrics.distanceKm} km · ${metrics.movingMinutes} min · ${metrics.elevationGain} m 爬升`,
  ];
  const performance = [
    metrics.averageSpeedKmh ? `均速 ${metrics.averageSpeedKmh} km/h` : null,
    metrics.normalizedPower ? `NP ${metrics.normalizedPower} W` : null,
    metrics.intensityFactor ? `IF ${metrics.intensityFactor}` : null,
    metrics.trainingStressScore ? `TSS ${metrics.trainingStressScore}` : null,
  ].filter(Boolean);
  if (performance.length) lines.push(`⚡ ${performance.join(" · ")}`);
  const body = [
    metrics.averageHeartRate ? `平均心率 ${metrics.averageHeartRate} bpm` : null,
    metrics.maxHeartRate ? `最高心率 ${metrics.maxHeartRate} bpm` : null,
    metrics.averageCadence ? `平均踏频 ${metrics.averageCadence} rpm` : null,
    metrics.workKilojoules ? `做功 ${metrics.workKilojoules} kJ` : null,
  ].filter(Boolean);
  if (body.length) lines.push(`🫀 ${body.join(" · ")}`);
  lines.push("由 izchu 根据 Strava 活动数据生成");
  return {
    activityId: activity.id,
    activityName: activity.name,
    description: lines.join("\n"),
    metrics,
    source: "strava",
  };
}

export function mergeSummary(existing: string | null | undefined, summary: string): string {
  const block = `${SUMMARY_START}\n${summary.trim()}\n${SUMMARY_END}`;
  const current = (existing ?? "").trim();
  const start = current.indexOf(SUMMARY_START);
  const end = current.indexOf(SUMMARY_END);
  if (start >= 0 && end >= start) {
    const before = current.slice(0, start).trimEnd();
    const after = current.slice(end + SUMMARY_END.length).trimStart();
    return [before, block, after].filter(Boolean).join("\n\n");
  }
  return current ? `${current}\n\n${block}` : block;
}
