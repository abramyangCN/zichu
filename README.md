# izchu

> Your ride, your data.

izchu 是一个面向 Strava 用户的开源、单用户、自托管活动摘要工具。每个人使用自己的 Strava API 应用，把服务部署在自己的 Cloudflare 账户中；活动与凭据不经过公共 izchu 服务器。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abramyangCN/izchu)

## 当前版本做什么

- 通过 Strava OAuth 读取最近活动、活动详情和可用的逐点 streams。
- 根据 Strava 已收到的数据生成距离、时间、爬升、NP、IF、TSS、心率、踏频与做功摘要。
- 默认由用户手动生成、预览并确认写入 Strava；自动摘要需要实例所有者另行启用。
- 写入时保留原描述，只新增或更新带 izchu 标记的摘要区块。
- Client Secret、access token 与 refresh token 使用管理员密码派生的密钥加密后存入 D1。
- 自动刷新过期的 Strava access token。
- 可选启用 Strava Webhook：新骑行或标题、类型、隐私变化时自动刷新摘要。

当前刻意不包含 Garmin Connect 和轮询定时任务。若 Garmin 码表已经把数据同步给 Strava，izchu 能使用 Strava API 实际暴露出来的字段；Strava 未提供的 Garmin 专有指标不会凭空出现。

## 架构

- Cloudflare Workers：Hono API 与 Strava OAuth
- Cloudflare D1：加密凭据、摘要历史与审计记录
- React + Vite：首次设置、活动列表与摘要确认界面
- Web Crypto：AES-GCM 数据加密与 HMAC 会话签名

一个仓库、一个 Worker、一个 D1 数据库，不需要群晖、常驻服务器或 Cron。

## 一键部署

1. 点击上方 **Deploy to Cloudflare**。
2. 授权 Cloudflare 创建 Worker 与 D1。
3. 设置 `IZCHU_ADMIN_PASSWORD`。请使用一个独立且足够长的密码；它既是页面登录密码，也是 D1 敏感字段的加密根密钥，遗失后无法解密旧凭据。
4. 打开部署后的网址，页面会显示 Strava 所需的回调域名。
5. 在 [Strava API Settings](https://www.strava.com/settings/api) 创建应用，将该域名填入 **Authorization Callback Domain**。
6. 回到 izchu 填写 Client ID、Client Secret 和可选 FTP，然后点击 **连接 Strava**。
7. 如需活动上传后自动写入摘要，在仪表盘中点击 **启用自动摘要**；izchu 会为这个 Strava API 应用创建唯一的 Webhook 订阅。

Strava 应用需要允许 `read`、`activity:read_all` 和 `activity:write`。写权限只在你点击并确认“写入 Strava”时使用。

## 本地开发

需要 Node.js 20.19+ 或 22.12+。

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

打开终端显示的本地地址，使用 `.dev.vars` 中的密码登录。常用检查：

```bash
npm run check
```

本地 D1 数据在 `.wrangler/` 中，`.dev.vars`、`.env`、`data/` 和所有本地数据库均已从 Git 排除。

## 手动部署

先登录 Cloudflare，然后创建 D1 数据库：

```bash
npx wrangler login
npx wrangler d1 create izchu-db
```

将命令返回的 `database_id` 写入 `wrangler.jsonc`，再设置密码并部署：

```bash
npx wrangler secret put IZCHU_ADMIN_PASSWORD
npm run deploy
```

## 数据与安全边界

- 每个实例只面向一个用户，不提供公共注册或多租户功能。
- 管理员密码不会存进 D1，但更换它会导致既有加密数据无法读取；如需更换，应先重新配置 Strava。
- 浏览器会话使用 `HttpOnly`、`SameSite=Lax` Cookie；生产环境自动启用 `Secure`。
- 写操作校验请求来源，OAuth 使用短期 state 防止请求伪造。
- Webhook 使用随机私密回调路径，并校验订阅 ID 与 Strava 运动员 ID；回调会先快速确认，再在 Worker 后台处理。
- Strava 凭据不会进入前端代码或 Git。
- D1 会保存摘要与最小审计记录，不保存完整逐秒活动副本。

## 产品原则

1. 明确授权：默认手动预览；只有实例所有者主动启用后才自动修改活动。
2. 数据最少化：只保存运行所需的数据。
3. 一人一实例：用户拥有部署、数据库和 API 凭据。
4. Strava 优先：先把核心链路做到可靠，再考虑可选数据源。

自动摘要默认关闭，必须由实例所有者明确启用。Strava Webhook 只通知活动创建、删除及标题、类型、隐私变化，不会通知每一种训练数据编辑；自动处理只作用于骑行类型。

## 开源许可

[MIT](LICENSE) — 可以自由使用、修改、部署与分发。
