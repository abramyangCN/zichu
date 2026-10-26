import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";
import { audit, clearTokens, getSettings, getToken, saveSettings, saveSummary } from "./db";
import { createSession, safeEqual, verifySession } from "./crypto";
import { activities, activityBundle, exchangeCode, updateDescription } from "./strava";
import { generateSummary, mergeSummary } from "./summary";

type AppContext = { Bindings: Env };
const app = new Hono<AppContext>();
const sessionCookie = "izchu_session";
const oauthCookie = "izchu_oauth_state";

function isSecure(c: { req: { url: string } }): boolean {
  return new URL(c.req.url).protocol === "https:";
}

function optionalNumber(value: unknown, minimum: number, maximum: number): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
}

app.use("/api/*", async (c, next) => {
  if (["/api/status", "/api/auth/login"].includes(c.req.path)) return next();
  if (!c.env.IZCHU_ADMIN_PASSWORD) return c.json({ error: "部署时尚未配置 IZCHU_ADMIN_PASSWORD" }, 503);
  const authenticated = await verifySession(
    c.env.IZCHU_ADMIN_PASSWORD,
    getCookie(c, sessionCookie),
  );
  if (!authenticated) return c.json({ error: "请先解锁 izchu" }, 401);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "请求来源无效" }, 403);
  }
  return next();
});

app.get("/api/status", async (c) => {
  const hasPassword = Boolean(c.env.IZCHU_ADMIN_PASSWORD);
  const authenticated = hasPassword
    ? await verifySession(c.env.IZCHU_ADMIN_PASSWORD, getCookie(c, sessionCookie))
    : false;
  if (!authenticated) {
    return c.json({ ready: hasPassword, authenticated: false, configured: false, connected: false });
  }
  const [settings, token] = await Promise.all([
    getSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD),
    getToken(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD),
  ]);
  return c.json({
    ready: true,
    authenticated: true,
    configured: Boolean(settings),
    connected: Boolean(token),
    athleteName: token?.athleteName ?? null,
    writeEnabled: token?.scope.split(/[ ,]+/u).includes("activity:write") ?? false,
    ftp: settings?.ftp ?? null,
    maxHeartRate: settings?.maxHeartRate ?? null,
  });
});

app.post("/api/auth/login", async (c) => {
  if (!c.env.IZCHU_ADMIN_PASSWORD) return c.json({ error: "部署时尚未配置管理员密码" }, 503);
  const body = await c.req.json<{ password?: string }>();
  if (!(await safeEqual(body.password ?? "", c.env.IZCHU_ADMIN_PASSWORD))) {
    return c.json({ error: "密码不正确" }, 401);
  }
  setCookie(c, sessionCookie, await createSession(c.env.IZCHU_ADMIN_PASSWORD), {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
  });
  return c.json({ authenticated: true });
});

app.post("/api/auth/logout", (c) => {
  deleteCookie(c, sessionCookie, { path: "/" });
  return c.json({ authenticated: false });
});

app.get("/api/settings", async (c) => {
  const settings = await getSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD);
  return c.json({
    configured: Boolean(settings),
    stravaClientId: settings?.stravaClientId ?? "",
    hasClientSecret: Boolean(settings?.stravaClientSecret),
    ftp: settings?.ftp ?? null,
    maxHeartRate: settings?.maxHeartRate ?? null,
    callbackUrl: `${new URL(c.req.url).origin}/api/strava/callback`,
    callbackDomain: new URL(c.req.url).host,
  });
});

app.put("/api/settings", async (c) => {
  const body = await c.req.json<{
    stravaClientId?: string;
    stravaClientSecret?: string;
    ftp?: number | string | null;
    maxHeartRate?: number | string | null;
  }>();
  const clientId = body.stravaClientId?.trim() ?? "";
  const existing = await getSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD);
  const clientSecret = body.stravaClientSecret?.trim() || existing?.stravaClientSecret || "";
  if (!/^\d+$/u.test(clientId) || !clientSecret) {
    return c.json({ error: "请填写有效的 Strava Client ID 和 Client Secret" }, 400);
  }
  const ftp = optionalNumber(body.ftp, 50, 700);
  const maxHeartRate = optionalNumber(body.maxHeartRate, 80, 240);
  await saveSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD, {
    stravaClientId: clientId,
    stravaClientSecret: clientSecret,
    ftp,
    maxHeartRate,
  });
  await audit(c.env.DB, "settings.updated", null, null);
  return c.json({ saved: true });
});

app.get("/api/strava/connect", async (c) => {
  const settings = await getSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD);
  if (!settings) return c.json({ error: "请先保存 Strava API 配置" }, 409);
  const state = crypto.randomUUID();
  setCookie(c, oauthCookie, state, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    maxAge: 10 * 60,
    path: "/api/strava/callback",
  });
  const query = new URLSearchParams({
    client_id: settings.stravaClientId,
    redirect_uri: `${new URL(c.req.url).origin}/api/strava/callback`,
    response_type: "code",
    approval_prompt: "auto",
    scope: "read,activity:read_all,activity:write",
    state,
  });
  return c.redirect(`https://www.strava.com/oauth/authorize?${query}`);
});

app.get("/api/strava/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const scope = c.req.query("scope") ?? "";
  const expected = getCookie(c, oauthCookie);
  deleteCookie(c, oauthCookie, { path: "/api/strava/callback" });
  if (!state || !expected || !(await safeEqual(state, expected)) || !code) {
    return c.redirect("/?strava=error");
  }
  try {
    const token = await exchangeCode(c.env, code, scope);
    await audit(c.env.DB, "strava.connected", null, String(token.athleteId));
    return c.redirect("/?strava=connected");
  } catch {
    return c.redirect("/?strava=error");
  }
});

app.post("/api/strava/disconnect", async (c) => {
  await clearTokens(c.env.DB);
  await audit(c.env.DB, "strava.disconnected", null, null);
  return c.json({ connected: false });
});

app.get("/api/strava/activities", async (c) => {
  const requested = Number(c.req.query("limit") ?? 20);
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 20, 1), 50);
  try {
    return c.json(await activities(c.env, limit));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "无法读取活动" }, 502);
  }
});

app.post("/api/strava/activities/:id/summary", async (c) => {
  const activityId = Number(c.req.param("id"));
  if (!Number.isSafeInteger(activityId)) return c.json({ error: "活动 ID 无效" }, 400);
  try {
    const [{ activity, streams }, settings] = await Promise.all([
      activityBundle(c.env, activityId),
      getSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD),
    ]);
    const summary = generateSummary(activity, streams, settings?.ftp ?? null);
    await saveSummary(c.env.DB, activity.id, activity.name, summary.description, false);
    return c.json(summary);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "摘要生成失败" }, 502);
  }
});

app.post("/api/strava/activities/:id/write-summary", async (c) => {
  const activityId = Number(c.req.param("id"));
  if (!Number.isSafeInteger(activityId)) return c.json({ error: "活动 ID 无效" }, 400);
  const token = await getToken(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD);
  if (!token?.scope.split(/[ ,]+/u).includes("activity:write")) {
    return c.json({ error: "需要重新授权 activity:write 权限" }, 409);
  }
  try {
    const [{ activity, streams }, settings] = await Promise.all([
      activityBundle(c.env, activityId),
      getSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD),
    ]);
    const summary = generateSummary(activity, streams, settings?.ftp ?? null);
    const description = mergeSummary(activity.description, summary.description);
    await updateDescription(c.env, activityId, description);
    await Promise.all([
      saveSummary(c.env.DB, activity.id, activity.name, summary.description, true),
      audit(c.env.DB, "strava.description.updated", activity.id, activity.name),
    ]);
    return c.json({ updated: true, description, summary });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "写入 Strava 失败" }, 502);
  }
});

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "izchu 暂时无法处理这个请求" }, 500);
});

export default app;
