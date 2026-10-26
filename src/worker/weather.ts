import { getCachedWeather, saveWeather } from "./db";
import type { ActivityWeather, StravaActivity } from "./types";

interface OpenMeteoHourly {
  time?: string[];
  temperature_2m?: Array<number | null>;
  apparent_temperature?: Array<number | null>;
  relative_humidity_2m?: Array<number | null>;
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
  0: "clear",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "foggy",
  48: "rime fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "rain showers",
  81: "rain showers",
  82: "heavy rain showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "heavy thunderstorm with hail",
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
      "relative_humidity_2m",
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
    relativeHumidityPercent: finite(body.hourly.relative_humidity_2m?.[index]),
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
  if (cached && cached.relativeHumidityPercent !== null) return cached;

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

function rounded(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function weatherSummary(weather: ActivityWeather): string {
  const temperatureFeel =
    weather.temperatureC <= 5
      ? "Cold"
      : weather.temperatureC <= 22
        ? "Cool"
        : weather.temperatureC <= 29
          ? "Warm"
          : "Hot";
  const condition =
    weather.weatherCode === null ? "weather unavailable" : weatherLabels[weather.weatherCode] ?? "weather unavailable";
  const conditionEmoji =
    weather.weatherCode === null
      ? "🌤️"
      : weather.weatherCode <= 1
        ? "☀️"
        : weather.weatherCode <= 3
          ? "☁️"
          : weather.weatherCode >= 95
            ? "⛈️"
            : weather.weatherCode >= 71 && weather.weatherCode <= 86
              ? "🌨️"
              : weather.weatherCode >= 51
                ? "🌧️"
                : "🌫️";
  return [
    "🌤️ 天气信息 | Open-Meteo",
    `${conditionEmoji} ${temperatureFeel}, ${condition}`,
    `🌡️ 温度：${rounded(weather.temperatureC)}°C`,
    weather.apparentTemperatureC === null
      ? null
      : `🧍 体感温度：${rounded(weather.apparentTemperatureC)}°C`,
    weather.windSpeedKmh === null ? null : `💨 风速：${rounded(weather.windSpeedKmh)} km/h`,
    weather.relativeHumidityPercent === null
      ? null
      : `💧 湿度：${Math.round(weather.relativeHumidityPercent)}%`,
  ]
    .filter(Boolean)
    .join("\n");
}
