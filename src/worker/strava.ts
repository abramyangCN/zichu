import { getSettings, getToken, saveToken } from "./db";
import type { StoredToken, StravaActivity, StravaStreams } from "./types";

const STRAVA_API = "https://www.strava.com/api/v3";
const STRAVA_OAUTH = "https://www.strava.com/oauth";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
  athlete?: { id: number; firstname?: string; lastname?: string };
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | { message?: string } | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body ? body.message : null;
    throw new Error(message || `Strava 请求失败（${response.status}）`);
  }
  return body as T;
}

async function refreshToken(env: Env, token: StoredToken): Promise<StoredToken> {
  const settings = await getSettings(env.DB, env.IZCHU_ADMIN_PASSWORD);
  if (!settings) throw new Error("请先配置 Strava API");
  const response = await fetch(`${STRAVA_OAUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: settings.stravaClientId,
      client_secret: settings.stravaClientSecret,
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
    }),
  });
  const value = await responseJson<TokenResponse>(response);
  const refreshed: StoredToken = {
    ...token,
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: value.expires_at,
  };
  await saveToken(env.DB, env.IZCHU_ADMIN_PASSWORD, refreshed);
  return refreshed;
}

async function accessToken(env: Env): Promise<string> {
  const stored = await getToken(env.DB, env.IZCHU_ADMIN_PASSWORD);
  if (!stored) throw new Error("请先连接 Strava");
  const current = stored.expiresAt <= Math.floor(Date.now() / 1000) + 60 ? await refreshToken(env, stored) : stored;
  return current.accessToken;
}

export async function exchangeCode(
  env: Env,
  code: string,
  scope: string,
): Promise<StoredToken> {
  const settings = await getSettings(env.DB, env.IZCHU_ADMIN_PASSWORD);
  if (!settings) throw new Error("请先配置 Strava API");
  const response = await fetch(`${STRAVA_OAUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: settings.stravaClientId,
      client_secret: settings.stravaClientSecret,
      code,
      grant_type: "authorization_code",
    }),
  });
  const value = await responseJson<TokenResponse>(response);
  if (!value.athlete) throw new Error("Strava 没有返回运动员信息");
  const token: StoredToken = {
    athleteId: value.athlete.id,
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: value.expires_at,
    scope,
    athleteName: [value.athlete.firstname, value.athlete.lastname].filter(Boolean).join(" ") || null,
  };
  await saveToken(env.DB, env.IZCHU_ADMIN_PASSWORD, token);
  return token;
}

export async function stravaFetch<T>(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await accessToken(env);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return responseJson<T>(await fetch(`${STRAVA_API}${path}`, { ...init, headers }));
}

export async function activities(env: Env, limit: number): Promise<StravaActivity[]> {
  return stravaFetch(env, `/athlete/activities?page=1&per_page=${limit}`);
}

export async function activityBundle(
  env: Env,
  activityId: number,
): Promise<{ activity: StravaActivity; streams: StravaStreams }> {
  const [activity, streamResponse] = await Promise.all([
    stravaFetch<StravaActivity>(env, `/activities/${activityId}`),
    stravaFetch<
      | Array<{ type: string; data: StravaStreams[string]["data"]; original_size: number; resolution: string }>
      | StravaStreams
    >(
      env,
      `/activities/${activityId}/streams?keys=time,distance,altitude,velocity_smooth,heartrate,cadence,watts,temp,moving,grade_smooth&key_by_type=true`,
    ),
  ]);
  const streams = Array.isArray(streamResponse)
    ? (Object.fromEntries(streamResponse.map((stream) => [stream.type, stream])) as StravaStreams)
    : streamResponse;
  return { activity, streams };
}

export async function updateDescription(
  env: Env,
  activityId: number,
  description: string,
): Promise<void> {
  await stravaFetch(env, `/activities/${activityId}`, {
    method: "PUT",
    body: JSON.stringify({ description }),
  });
}
