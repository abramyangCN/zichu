import { decrypt, encrypt } from "./crypto";
import type {
  ActivityWeather,
  IzchuSettings,
  StoredToken,
  StravaWebhookEvent,
  WebhookSettings,
} from "./types";

interface SettingsRow {
  strava_client_id: string;
  strava_client_secret: string;
  ftp: number | null;
  max_heart_rate: number | null;
  weather_enabled: number;
  power_meter_name: string | null;
}

interface TokenRow {
  athlete_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  athlete_name: string | null;
}

interface WebhookRow {
  subscription_id: number | null;
  callback_token: string;
  enabled: number;
  last_event_at: string | null;
  last_error: string | null;
}

export async function getSettings(db: D1Database, secret: string): Promise<IzchuSettings | null> {
  const row = await db
    .prepare(
      "SELECT strava_client_id, strava_client_secret, ftp, max_heart_rate, weather_enabled, power_meter_name FROM settings WHERE id = 1",
    )
    .first<SettingsRow>();
  if (!row) return null;
  return {
    stravaClientId: row.strava_client_id,
    stravaClientSecret: await decrypt(secret, row.strava_client_secret),
    ftp: row.ftp,
    maxHeartRate: row.max_heart_rate,
    weatherEnabled: row.weather_enabled === 1,
    powerMeterName: row.power_meter_name,
  };
}

export async function saveSettings(
  db: D1Database,
  secret: string,
  value: IzchuSettings,
): Promise<void> {
  const encryptedSecret = await encrypt(secret, value.stravaClientSecret);
  await db
    .prepare(
      `INSERT INTO settings (id, strava_client_id, strava_client_secret, ftp, max_heart_rate, weather_enabled, power_meter_name)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         strava_client_id = excluded.strava_client_id,
         strava_client_secret = excluded.strava_client_secret,
         ftp = excluded.ftp,
         max_heart_rate = excluded.max_heart_rate,
         weather_enabled = excluded.weather_enabled,
         power_meter_name = excluded.power_meter_name,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      value.stravaClientId,
      encryptedSecret,
      value.ftp,
      value.maxHeartRate,
      value.weatherEnabled ? 1 : 0,
      value.powerMeterName,
    )
    .run();
}

interface WeatherRow {
  activity_id: number;
  observed_at: string;
  temperature_c: number;
  apparent_temperature_c: number | null;
  relative_humidity_percent: number | null;
  precipitation_mm: number | null;
  wind_speed_kmh: number | null;
  wind_direction_degrees: number | null;
  weather_code: number | null;
}

export async function getCachedWeather(
  db: D1Database,
  activityId: number,
): Promise<ActivityWeather | null> {
  const row = await db
    .prepare(
      `SELECT activity_id, observed_at, temperature_c, apparent_temperature_c,
              relative_humidity_percent,
              precipitation_mm, wind_speed_kmh, wind_direction_degrees, weather_code
       FROM activity_weather WHERE activity_id = ?`,
    )
    .bind(activityId)
    .first<WeatherRow>();
  if (!row) return null;
  return {
    activityId: row.activity_id,
    observedAt: row.observed_at,
    temperatureC: row.temperature_c,
    apparentTemperatureC: row.apparent_temperature_c,
    relativeHumidityPercent: row.relative_humidity_percent,
    precipitationMm: row.precipitation_mm,
    windSpeedKmh: row.wind_speed_kmh,
    windDirectionDegrees: row.wind_direction_degrees,
    weatherCode: row.weather_code,
    source: "open-meteo",
  };
}

export async function saveWeather(db: D1Database, weather: ActivityWeather): Promise<void> {
  await db
    .prepare(
      `INSERT INTO activity_weather
       (activity_id, observed_at, temperature_c, apparent_temperature_c,
        relative_humidity_percent, precipitation_mm, wind_speed_kmh,
        wind_direction_degrees, weather_code, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(activity_id) DO UPDATE SET
         observed_at = excluded.observed_at,
         temperature_c = excluded.temperature_c,
         apparent_temperature_c = excluded.apparent_temperature_c,
         relative_humidity_percent = excluded.relative_humidity_percent,
         precipitation_mm = excluded.precipitation_mm,
         wind_speed_kmh = excluded.wind_speed_kmh,
         wind_direction_degrees = excluded.wind_direction_degrees,
         weather_code = excluded.weather_code,
         source = excluded.source,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      weather.activityId,
      weather.observedAt,
      weather.temperatureC,
      weather.apparentTemperatureC,
      weather.relativeHumidityPercent,
      weather.precipitationMm,
      weather.windSpeedKmh,
      weather.windDirectionDegrees,
      weather.weatherCode,
      weather.source,
    )
    .run();
}

export async function getToken(db: D1Database, secret: string): Promise<StoredToken | null> {
  const row = await db
    .prepare(
      `SELECT athlete_id, access_token, refresh_token, expires_at, scope, athlete_name
       FROM oauth_tokens ORDER BY updated_at DESC LIMIT 1`,
    )
    .first<TokenRow>();
  if (!row) return null;
  return {
    athleteId: row.athlete_id,
    accessToken: await decrypt(secret, row.access_token),
    refreshToken: await decrypt(secret, row.refresh_token),
    expiresAt: row.expires_at,
    scope: row.scope,
    athleteName: row.athlete_name,
  };
}

export async function saveToken(db: D1Database, secret: string, token: StoredToken): Promise<void> {
  const [accessToken, refreshToken] = await Promise.all([
    encrypt(secret, token.accessToken),
    encrypt(secret, token.refreshToken),
  ]);
  await db
    .prepare(
      `INSERT INTO oauth_tokens
       (athlete_id, access_token, refresh_token, expires_at, scope, athlete_name)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(athlete_id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         scope = excluded.scope,
         athlete_name = excluded.athlete_name,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      token.athleteId,
      accessToken,
      refreshToken,
      token.expiresAt,
      token.scope,
      token.athleteName,
    )
    .run();
}

export async function clearTokens(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM oauth_tokens").run();
}

export async function getWebhookSettings(
  db: D1Database,
  secret: string,
): Promise<WebhookSettings | null> {
  const row = await db
    .prepare(
      `SELECT subscription_id, callback_token, enabled, last_event_at, last_error
       FROM webhook_settings WHERE id = 1`,
    )
    .first<WebhookRow>();
  if (!row) return null;
  return {
    subscriptionId: row.subscription_id,
    callbackToken: await decrypt(secret, row.callback_token),
    enabled: row.enabled === 1,
    lastEventAt: row.last_event_at,
    lastError: row.last_error,
  };
}

export async function saveWebhookSettings(
  db: D1Database,
  secret: string,
  value: Pick<WebhookSettings, "subscriptionId" | "callbackToken" | "enabled">,
): Promise<void> {
  const encryptedToken = await encrypt(secret, value.callbackToken);
  await db
    .prepare(
      `INSERT INTO webhook_settings (id, subscription_id, callback_token, enabled, last_error)
       VALUES (1, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         subscription_id = excluded.subscription_id,
         callback_token = excluded.callback_token,
         enabled = excluded.enabled,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(value.subscriptionId, encryptedToken, value.enabled ? 1 : 0)
    .run();
}

export async function disableWebhook(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE webhook_settings
       SET subscription_id = NULL, enabled = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
    )
    .run();
}

export async function claimWebhookEvent(
  db: D1Database,
  event: StravaWebhookEvent,
): Promise<{ claimed: boolean; eventKey: string }> {
  const eventKey = [
    event.subscription_id,
    event.object_type,
    event.object_id,
    event.aspect_type,
    event.event_time,
  ].join(":");
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO webhook_events
       (event_key, subscription_id, object_type, object_id, aspect_type, event_time)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      eventKey,
      event.subscription_id,
      event.object_type,
      event.object_id,
      event.aspect_type,
      event.event_time,
    )
    .run();
  return { claimed: (result.meta.changes ?? 0) > 0, eventKey };
}

export async function finishWebhookEvent(
  db: D1Database,
  eventKey: string,
  error: string | null,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE webhook_events
         SET status = ?, error = ?, processed_at = CURRENT_TIMESTAMP
         WHERE event_key = ?`,
      )
      .bind(error ? "error" : "processed", error, eventKey),
    db
      .prepare(
        `UPDATE webhook_settings
         SET last_event_at = CURRENT_TIMESTAMP, last_error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`,
      )
      .bind(error),
  ]);
}

export async function saveSummary(
  db: D1Database,
  activityId: number,
  activityName: string,
  summary: string,
  writtenToStrava: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO summary_history
       (activity_id, activity_name, summary, written_to_strava)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(activityId, activityName, summary, writtenToStrava ? 1 : 0)
    .run();
}

export async function getLatestWrittenSummary(
  db: D1Database,
  activityId: number,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT summary FROM summary_history
       WHERE activity_id = ? AND written_to_strava = 1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(activityId)
    .first<{ summary: string }>();
  return row?.summary ?? null;
}

export async function audit(
  db: D1Database,
  action: string,
  activityId: number | null,
  detail: string | null,
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (action, activity_id, detail) VALUES (?, ?, ?)")
    .bind(action, activityId, detail)
    .run();
}
