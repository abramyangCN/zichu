import {
  audit,
  claimWebhookEvent,
  clearTokens,
  finishWebhookEvent,
  getSettings,
  getToken,
  saveSummary,
} from "./db";
import { activityBundle, updateDescription } from "./strava";
import { generateSummary, isCyclingActivity, mergeSummary, removeSummary } from "./summary";
import type { StravaWebhookEvent } from "./types";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loadActivity(env: Env, activityId: number) {
  let lastError: unknown;
  for (const wait of [0, 2_000, 5_000]) {
    if (wait) await delay(wait);
    try {
      return await activityBundle(env, activityId);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法读取活动");
}

export async function processWebhookEvent(env: Env, event: StravaWebhookEvent): Promise<void> {
  const { claimed, eventKey } = await claimWebhookEvent(env.DB, event);
  if (!claimed) return;

  let failure: string | null = null;
  try {
    if (
      event.object_type === "athlete" &&
      (event.updates?.authorized === "false" || event.updates?.authorized === false)
    ) {
      await Promise.all([
        clearTokens(env.DB),
        audit(env.DB, "strava.deauthorized", null, String(event.owner_id)),
      ]);
      return;
    }

    if (event.object_type !== "activity") return;
    if (event.aspect_type === "delete") {
      await audit(env.DB, "webhook.activity.deleted", event.object_id, null);
      return;
    }

    const token = await getToken(env.DB, env.IZCHU_ADMIN_PASSWORD);
    if (!token || token.athleteId !== event.owner_id) {
      throw new Error("Webhook 运动员与当前 Strava 连接不匹配");
    }
    if (!token.scope.split(/[ ,]+/u).includes("activity:write")) {
      throw new Error("当前 Strava 授权缺少 activity:write");
    }

    const [{ activity, streams }, settings] = await Promise.all([
      loadActivity(env, event.object_id),
      getSettings(env.DB, env.IZCHU_ADMIN_PASSWORD),
    ]);

    if (!isCyclingActivity(activity)) {
      const description = removeSummary(activity.description);
      if (description !== (activity.description ?? "").trim()) {
        await updateDescription(env, activity.id, description);
        await audit(env.DB, "webhook.summary.removed", activity.id, activity.name);
      }
      return;
    }

    const summary = generateSummary(activity, streams, settings?.ftp ?? null);
    const description = mergeSummary(activity.description, summary.description);
    if (description === (activity.description ?? "").trim()) {
      await audit(env.DB, "webhook.summary.unchanged", activity.id, activity.name);
      return;
    }

    await updateDescription(env, activity.id, description);
    await Promise.all([
      saveSummary(env.DB, activity.id, activity.name, summary.description, true),
      audit(env.DB, "webhook.summary.updated", activity.id, activity.name),
    ]);
  } catch (error) {
    failure = error instanceof Error ? error.message : "Webhook 处理失败";
    console.error("Strava webhook processing failed", error);
  } finally {
    await finishWebhookEvent(env.DB, eventKey, failure);
  }
}
