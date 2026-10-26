import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";
import {
  audit,
  clearTokens,
  disableWebhook,
  getSettings,
  getToken,
  getWebhookSettings,
  saveSettings,
  saveSummary,
  saveWebhookSettings,
} from "./db";
import { createSession, safeEqual, verifySession } from "./crypto";
import {
  activities,
  activityBundle,
  createPushSubscription,
  deletePushSubscription,
  exchangeCode,
  listPushSubscriptions,
  updateDescription,
} from "./strava";
import { generateSummary, mergeSummary } from "./summary";
import type { StravaWebhookEvent } from "./types";
import { processWebhookEvent } from "./webhook";

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

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function isWebhookEvent(value: unknown): value is StravaWebhookEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<StravaWebhookEvent>;
  return (
    ["activity", "athlete"].includes(event.object_type ?? "") &&
    ["create", "update", "delete"].includes(event.aspect_type ?? "") &&
    Number.isSafeInteger(event.object_id) &&
    Number.isSafeInteger(event.owner_id) &&
    Number.isSafeInteger(event.subscription_id) &&
    Number.isSafeInteger(event.event_time)
  );
}

app.use("/api/*", async (c, next) => {
  if (
    ["/api/status", "/api/auth/login"].includes(c.req.path) ||
    c.req.path.startsWith("/api/strava/webhook/")
  ) {
    return next();
  }
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
  const [settings, token, webhook] = await Promise.all([
    getSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD),
    getToken(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD),
    getWebhookSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD),
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
    webhookEnabled: webhook?.enabled ?? false,
    webhookLastEventAt: webhook?.lastEventAt ?? null,
    webhookLastError: webhook?.lastError ?? null,
  });
});

app.get("/api/strava/webhook/:token", async (c) => {
  if (!c.env.IZCHU_ADMIN_PASSWORD) return c.json({ error: "Webhook 尚未配置" }, 503);
  const webhook = await getWebhookSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD);
  const suppliedToken = c.req.param("token");
  const verifyToken = c.req.query("hub.verify_token") ?? "";
  const mode = c.req.query("hub.mode");
  const challenge = c.req.query("hub.challenge");
  const valid =
    webhook?.enabled &&
    mode === "subscribe" &&
    challenge &&
    (await safeEqual(suppliedToken, webhook.callbackToken)) &&
    (await safeEqual(verifyToken, webhook.callbackToken));
  if (!valid) return c.json({ error: "Webhook 验证失败" }, 403);
  return c.json({ "hub.challenge": challenge });
});

app.post("/api/strava/webhook/:token", async (c) => {
  if (!c.env.IZCHU_ADMIN_PASSWORD) return c.json({ error: "Webhook 尚未配置" }, 503);
  const webhook = await getWebhookSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD);
  if (
    !webhook?.enabled ||
    !(await safeEqual(c.req.param("token"), webhook.callbackToken))
  ) {
    return c.json({ error: "Webhook 验证失败" }, 403);
  }
  const event = await c.req.json<unknown>().catch(() => null);
  if (!isWebhookEvent(event)) return c.json({ error: "Webhook 内容无效" }, 400);
  if (webhook.subscriptionId && event.subscription_id !== webhook.subscriptionId) {
    return c.json({ error: "Webhook 订阅不匹配" }, 403);
  }
  c.executionCtx.waitUntil(processWebhookEvent(c.env, event));
  return c.json({ received: true });
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

app.post("/api/strava/webhook-subscription", async (c) => {
  const origin = new URL(c.req.url).origin;
  const url = new URL(origin);
  if (url.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(url.hostname)) {
    return c.json({ error: "Strava Webhook 只能连接公开的 HTTPS 部署地址" }, 409);
  }
  const token = await getToken(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD);
  if (!token?.scope.split(/[ ,]+/u).includes("activity:write")) {
    return c.json({ error: "请先授权 Strava 的 activity:write 权限" }, 409);
  }

  const stored = await getWebhookSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD);
  if (stored?.enabled && stored.subscriptionId) {
    return c.json({ enabled: true, subscriptionId: stored.subscriptionId });
  }
  const callbackToken = stored?.callbackToken || randomToken();
  const callbackUrl = `${origin}/api/strava/webhook/${callbackToken}`;

  try {
    const subscriptions = await listPushSubscriptions(c.env);
    const matching = subscriptions.find((subscription) => subscription.callback_url === callbackUrl);
    if (matching) {
      await saveWebhookSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD, {
        subscriptionId: matching.id,
        callbackToken,
        enabled: true,
      });
      return c.json({ enabled: true, subscriptionId: matching.id });
    }
    if (subscriptions.length > 0) {
      return c.json(
        { error: "这个 Strava API 应用已有其他 Webhook 订阅，请先删除旧订阅再启用" },
        409,
      );
    }

    await saveWebhookSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD, {
      subscriptionId: null,
      callbackToken,
      enabled: true,
    });
    const subscription = await createPushSubscription(c.env, callbackUrl, callbackToken);
    await saveWebhookSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD, {
      subscriptionId: subscription.id,
      callbackToken,
      enabled: true,
    });
    await audit(c.env.DB, "webhook.enabled", null, String(subscription.id));
    return c.json({ enabled: true, subscriptionId: subscription.id });
  } catch (error) {
    await disableWebhook(c.env.DB);
    return c.json(
      { error: error instanceof Error ? error.message : "Webhook 启用失败" },
      502,
    );
  }
});

app.delete("/api/strava/webhook-subscription", async (c) => {
  const webhook = await getWebhookSettings(c.env.DB, c.env.IZCHU_ADMIN_PASSWORD);
  try {
    if (webhook?.subscriptionId) {
      await deletePushSubscription(c.env, webhook.subscriptionId);
    }
    await disableWebhook(c.env.DB);
    await audit(c.env.DB, "webhook.disabled", null, webhook?.subscriptionId?.toString() ?? null);
    return c.json({ enabled: false });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Webhook 关闭失败" },
      502,
    );
  }
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
