import { FormEvent, useCallback, useEffect, useState } from "react";

type Status = {
  ready: boolean;
  authenticated: boolean;
  configured: boolean;
  connected: boolean;
  athleteName?: string | null;
  writeEnabled?: boolean;
  ftp?: number | null;
  webhookEnabled?: boolean;
  webhookLastEventAt?: string | null;
  webhookLastError?: string | null;
};

type Settings = {
  configured: boolean;
  stravaClientId: string;
  hasClientSecret: boolean;
  ftp: number | null;
  maxHeartRate: number | null;
  callbackUrl: string;
  callbackDomain: string;
};

type Activity = {
  id: number;
  name: string;
  sport_type?: string;
  type?: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  total_elevation_gain: number;
  average_watts?: number;
};

type Summary = {
  activityId: number;
  activityName: string;
  description: string;
  metrics: Record<string, number | null>;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

function formatDate(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(normalized));
}

function rideType(activity: Activity) {
  const type = activity.sport_type || activity.type || "Activity";
  return type.replace("VirtualRide", "虚拟骑行").replace("Ride", "骑行");
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await api<Status>("/api/status");
      setStatus(next);
      if (next.authenticated) {
        const configured = await api<Settings>("/api/settings");
        setSettings(configured);
        if (next.connected) setActivities(await api<Activity[]>("/api/strava/activities?limit=20"));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("login");
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password: form.get("password") }) });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法解锁");
    } finally {
      setBusy("");
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("settings");
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          stravaClientId: form.get("clientId"),
          stravaClientSecret: form.get("clientSecret"),
          ftp: form.get("ftp"),
          maxHeartRate: form.get("maxHeartRate"),
        }),
      });
      setMessage("配置已加密保存。现在可以连接 Strava。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy("");
    }
  }

  async function makeSummary(activity: Activity) {
    setBusy(`summary-${activity.id}`);
    setMessage("");
    try {
      setSummary(await api<Summary>(`/api/strava/activities/${activity.id}/summary`, { method: "POST" }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "摘要生成失败");
    } finally {
      setBusy("");
    }
  }

  async function writeSummary() {
    if (!summary || !window.confirm("确认把这段摘要写入该活动的 Strava 描述？原有描述会保留。")) return;
    setBusy("write");
    try {
      await api(`/api/strava/activities/${summary.activityId}/write-summary`, { method: "POST" });
      setMessage("已写入 Strava。以后再次写入只会更新 izchu 摘要区块。");
      setSummary(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "写入失败");
    } finally {
      setBusy("");
    }
  }

  async function toggleWebhook() {
    if (!status?.connected) return;
    const currentlyEnabled = Boolean(status.webhookEnabled);
    if (
      !currentlyEnabled &&
      !window.confirm("启用后，新骑行或 Strava 通知的骑行更新会自动生成摘要并写入活动描述。确认启用？")
    ) {
      return;
    }
    setBusy("webhook");
    setMessage("");
    try {
      await api("/api/strava/webhook-subscription", {
        method: currentlyEnabled ? "DELETE" : "POST",
      });
      setMessage(currentlyEnabled ? "自动摘要已关闭。" : "自动摘要已启用，下一次骑行事件会自动处理。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "自动摘要设置失败");
    } finally {
      setBusy("");
    }
  }

  if (!status) return <main className="center"><div className="loader" /><p>正在唤醒 izchu…</p></main>;
  if (!status.ready) return <main className="center"><Brand /><section className="panel narrow"><span className="eyebrow">还差一步</span><h1>设置管理员密码</h1><p>在 Cloudflare 项目的变量和机密中添加 <code>IZCHU_ADMIN_PASSWORD</code>，然后重新部署。</p></section></main>;
  if (!status.authenticated) return <main className="center login"><Brand /><section className="panel narrow"><span className="eyebrow">私有骑行空间</span><h1>欢迎回来</h1><p>用部署时设置的密码解锁。你的 Strava 凭据只保存在自己的 Cloudflare 账户中。</p><form onSubmit={login}><label>管理员密码<input name="password" type="password" autoComplete="current-password" required autoFocus /></label><button className="primary" disabled={busy === "login"}>{busy ? "解锁中…" : "解锁 izchu"}</button></form>{message && <p className="notice error">{message}</p>}</section></main>;

  return (
    <div className="app-shell">
      <header><Brand /><nav><span className="privacy"><i /> 数据只属于你</span><button className="text-button" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); }}>退出</button></nav></header>
      <main className="content">
        <section className="hero"><div><span className="eyebrow">STRAVA · PRIVATE BY DEFAULT</span><h1>{status.connected ? `${status.athleteName || "骑手"}，今天也去骑吧。` : "把训练数据，留在自己手里。"}</h1><p>{status.connected ? "手动预览每次摘要，或者按你的选择启用自动同步。" : "连接自己的 Strava API。没有订阅服务，没有共享数据库，也不会未经允许自动改动。"}</p></div><div className="hero-mark">i<span>z</span></div></section>
        {message && <div className="notice">{message}</div>}
        {!status.configured || !status.connected ? <Setup settings={settings} status={status} busy={busy} onSave={saveSettings} /> : <>
          <section className="stats"><div><span>连接状态</span><strong className="good">● 已连接</strong></div><div><span>最近活动</span><strong>{activities.length}</strong></div><div><span>摘要方式</span><strong>{status.webhookEnabled ? "自动同步" : "手动确认"}</strong></div><div><span>训练 FTP</span><strong>{status.ftp ? `${status.ftp} W` : "未设置"}</strong></div></section>
          <section className={`automation-card ${status.webhookEnabled ? "enabled" : ""}`}><div className="automation-status"><span className="pulse" /><div><span className="eyebrow">STRAVA WEBHOOK</span><h2>自动更新骑行摘要</h2><p>{status.webhookEnabled ? "已监听新骑行以及标题、类型和隐私变化。摘要发生变化时会自动写回 Strava。" : "启用后无需刷新页面；Strava 有新的骑行事件时，izchu 会在后台生成并更新摘要。"}</p>{status.webhookLastEventAt && <small>最近事件：{formatDate(status.webhookLastEventAt)}</small>}{status.webhookLastError && <small className="webhook-error">最近错误：{status.webhookLastError}</small>}</div></div><button className={status.webhookEnabled ? "secondary" : "primary"} disabled={busy === "webhook" || !status.writeEnabled} onClick={() => void toggleWebhook()}>{busy === "webhook" ? "处理中…" : status.webhookEnabled ? "关闭自动摘要" : "启用自动摘要"}</button></section>
          <section className="section-heading"><div><span className="eyebrow">RECENT RIDES</span><h2>最近活动</h2></div><button className="secondary" onClick={() => void refresh()}>刷新</button></section>
          <section className="ride-list">{activities.length === 0 ? <div className="empty">Strava 暂时没有返回活动。</div> : activities.map((activity) => <article className="ride" key={activity.id}><div className="ride-icon">↗</div><div className="ride-main"><div className="ride-meta"><span>{rideType(activity)}</span><time>{formatDate(activity.start_date_local)}</time></div><h3>{activity.name}</h3><div className="ride-numbers"><span><b>{(activity.distance / 1000).toFixed(1)}</b> km</span><span><b>{Math.round(activity.moving_time / 60)}</b> min</span><span><b>{Math.round(activity.total_elevation_gain)}</b> m</span>{activity.average_watts ? <span><b>{Math.round(activity.average_watts)}</b> W</span> : null}</div></div><button className="primary compact" disabled={Boolean(busy)} onClick={() => void makeSummary(activity)}>{busy === `summary-${activity.id}` ? "生成中…" : "生成摘要"}</button></article>)}</section>
          <details className="settings-drawer"><summary>调整 Strava 与训练设置</summary><Setup settings={settings} status={status} busy={busy} onSave={saveSettings} compact /></details>
        </>}
      </main>
      {summary && <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setSummary(null); }}><section className="summary-modal"><button className="close" aria-label="关闭" onClick={() => setSummary(null)}>×</button><span className="eyebrow">摘要预览</span><h2>{summary.activityName}</h2><pre>{summary.description}</pre><p className="safe-note">写入时会保留原活动描述；izchu 只更新自己的摘要区块。</p><div className="actions"><button className="secondary" onClick={() => setSummary(null)}>暂不写入</button><button className="primary" disabled={busy === "write" || !status.writeEnabled} onClick={() => void writeSummary()}>{busy === "write" ? "写入中…" : "确认写入 Strava"}</button></div>{!status.writeEnabled && <p className="notice error">当前授权缺少写入权限，请断开后重新连接 Strava。</p>}</section></div>}
      <footer>izchu · open source · your ride, your data</footer>
    </div>
  );
}

function Brand() {
  return <a className="brand" href="/" aria-label="izchu 首页"><span>i</span>zchu<em>骑</em></a>;
}

function Setup({ settings, status, busy, onSave, compact = false }: { settings: Settings | null; status: Status; busy: string; onSave: (event: FormEvent<HTMLFormElement>) => void; compact?: boolean }) {
  if (!settings) return null;
  return <section className={`setup ${compact ? "compact-setup" : ""}`}><div className="setup-copy"><span className="step">{status.configured ? "02" : "01"}</span><span className="eyebrow">一次性设置</span><h2>{status.configured ? "连接你的 Strava" : "填写 Strava API 凭据"}</h2><p>在 Strava API 设置中，把下方域名填入 <b>Authorization Callback Domain</b>。每套部署只服务一个人。</p><div className="callback"><span>回调域名</span><code>{settings.callbackDomain}</code><small>{settings.callbackUrl}</small></div></div><div className="panel setup-form"><form onSubmit={onSave}><label>Client ID<input name="clientId" inputMode="numeric" defaultValue={settings.stravaClientId} placeholder="例如 123456" required /></label><label>Client Secret<input name="clientSecret" type="password" placeholder={settings.hasClientSecret ? "已保存，留空则不修改" : "粘贴 Client Secret"} required={!settings.hasClientSecret} /></label><div className="two"><label>FTP（可选）<input name="ftp" type="number" min="50" max="700" defaultValue={settings.ftp ?? ""} placeholder="用于 IF / TSS" /></label><label>最大心率（可选）<input name="maxHeartRate" type="number" min="80" max="240" defaultValue={settings.maxHeartRate ?? ""} /></label></div><button className="primary" disabled={busy === "settings"}>{busy === "settings" ? "保存中…" : "保存配置"}</button></form>{status.configured && <a className="strava-button" href="/api/strava/connect">{status.connected ? "重新授权 Strava" : "连接 Strava"}</a>}</div></section>;
}
