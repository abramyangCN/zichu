import { getCachedWeather, saveWeather } from "./db";
import type { ActivityWeather, StravaActivity } from "./types";

interface OpenMeteoHourly {
  time?: string[];
  temperature_2m?: Array<number | null>;
  apparent_temperature?: Array<number | null>;
  precipitation?: Array<number | null>;
  weather_code?: Array<number | null>;
  wind_speed_10m?: Array<number | null>;
  wind_direction_10m?: Array<number | null>;
}

interface OpenMeteoResponse {
  hourly?: OpenMeteoHourly;
  reason?: string;
}

const weatherLabels: Record<number, string> = {
  0: "晴",
  1: "大致晴朗",
  2: "多云",
  3: "阴",
  45: "有雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "较强毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "米雪",
  80: "阵雨",
  81: "较强阵雨",
  82: "强阵雨",
  85: "阵雪",
  86: "强阵雪",
  95: "雷暴",
  96: "雷暴伴冰雹",
  99: "强雷暴伴冰雹",
};

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundedCoordinate(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function endpoint(activity: StravaActivity, host: string): URL | null {
  const coordinates = activity.start_latlng;
  const date = activity.start_date_local.slice(0, 10);
  if (!coordinates || coordinates.length !== 2 || !date) return null;
  const url = new URL(`https://${host}/v1/${host.startsWith("archive-") ? "archive" : "forecast"}`);
  url.search = new URLSearchParams({
    latitude: roundedCoordinate(coordinates[0]),
    longitude: roundedCoordinate(coordinates[1]),
    start_date: date,
    end_date: date,
    timezone: "auto",
    hourly: [
      "temperature_2m",
      "apparent_temperature",
      "precipitation",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
    ].join(","),
  }).toString();
  return url;
}

async function requestWeather(activity: StravaActivity, host: string): Promise<ActivityWeather> {
  const url = endpoint(activity, host);
  if (!url) throw new Error("活动没有可用的起点坐标");
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const body = (await response.json().catch(() => ({}))) as OpenMeteoResponse;
  if (!response.ok || !body.hourly?.time?.length) {
    throw new Error(body.reason || `Open-Meteo 请求失败（${response.status}）`);
  }
  const targetHour = `${activity.start_date_local.slice(0, 13)}:00`;
  const index = body.hourly.time.indexOf(targetHour);
  if (index < 0) throw new Error("Open-Meteo 没有返回活动开始时段");
  const temperature = finite(body.hourly.temperature_2m?.[index]);
  if (temperature === null) throw new Error("Open-Meteo 没有返回温度");
  return {
    activityId: activity.id,
    observedAt: body.hourly.time[index],
    temperatureC: temperature,
    apparentTemperatureC: finite(body.hourly.apparent_temperature?.[index]),
    precipitationMm: finite(body.hourly.precipitation?.[index]),
    windSpeedKmh: finite(body.hourly.wind_speed_10m?.[index]),
    windDirectionDegrees: finite(body.hourly.wind_direction_10m?.[index]),
    weatherCode: finite(body.hourly.weather_code?.[index]),
    source: "open-meteo",
  };
}

export async function activityWeather(
  db: D1Database,
  activity: StravaActivity,
): Promise<ActivityWeather | null> {
  if (!activity.start_latlng?.length) return null;
  const cached = await getCachedWeather(db, activity.id);
  if (cached) return cached;

  const startedAt = new Date(activity.start_date ?? activity.start_date_local).getTime();
  const recent = Number.isFinite(startedAt) && Date.now() - startedAt < 5 * 24 * 60 * 60 * 1000;
  const hosts = recent
    ? ["api.open-meteo.com", "archive-api.open-meteo.com"]
    : ["archive-api.open-meteo.com"];
  let lastError: unknown;
  for (const host of hosts) {
    try {
      const weather = await requestWeather(activity, host);
      await saveWeather(db, weather);
      return weather;
    } catch (error) {
      lastError = error;
    }
  }
  console.warn("Weather lookup skipped", lastError);
  return null;
}

function windDirection(value: number): string {
  const labels = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  return labels[Math.round((((value % 360) + 360) % 360) / 45) % labels.length];
}

function rounded(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function weatherSummary(weather: ActivityWeather): string {
  const details = [
    weather.weatherCode === null ? null : weatherLabels[weather.weatherCode] ?? "天气未知",
    `${rounded(weather.temperatureC)}°C`,
    weather.apparentTemperatureC === null
      ? null
      : `体感 ${rounded(weather.apparentTemperatureC)}°C`,
    weather.windSpeedKmh === null
      ? null
      : `风 ${rounded(weather.windSpeedKmh)} km/h${
          weather.windDirectionDegrees === null ? "" : ` ${windDirection(weather.windDirectionDegrees)}风`
        }`,
    weather.precipitationMm && weather.precipitationMm > 0
      ? `降水 ${rounded(weather.precipitationMm)} mm`
      : null,
  ].filter(Boolean);
  return `🌤️ ${details.join(" · ")}（Open-Meteo 估算）`;
}
