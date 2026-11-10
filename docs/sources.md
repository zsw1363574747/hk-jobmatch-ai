# 多平台 JD 抓取（sources）

一句话：**一个关键词 → 能抓的站全抓 → 合并去重 → 同一套打分**。
每个来源都实现同一份契约，加站只加一个文件，服务和界面不用动。

```
关键词
  ├─ jobsdb      HTTP   列表 v5 接口 + GraphQL 拿 JD 全文   ← 当前只启用这个
  ├─ govhk      浏览器  劳工处职位（搜索与详情都在页面里发同源请求）
  ├─ ctgoodjobs 浏览器  AWS WAF：需要人工过一次验证（已停用，代码保留）
  ├─ linkedin   浏览器  登录墙 / 网络限制，常被挡
  └─ indeed     浏览器  Cloudflare，常被挡
        ↓
   合并去重（title+company 指纹）
        ↓
   规则打分 → 经验门槛 → 报告
```

> 来源分两层：`CATALOG`（所有适配器，含停用的）和 `ENABLED_SOURCE_IDS`（真正参与搜索的）。
> 停用只从启用列表里拿掉，模块留着，历史 run 的详情照样能打开。

## 每个来源的契约

```js
export const descriptor = {
  id: 'jobsdb', label: 'JobsDB', kind: 'http' | 'browser',
  home, note, needsBrowser: boolean,
}

export async function search({ keywords, pages, detailLimit }) {
  return { source, jobs, totalCount, warnings: [{ code, note }], ms, blocked? }
}

export async function fetchDetail(job) {
  return { ok, detail: { contentText, contentChars, source }, warnings }
}
```

`job` 的统一形状（`bundle/lib/sources/jobsdb.js` 里 `normalizeSearch` 是最完整的例子）：

| 字段 | 说明 |
|---|---|
| `key` | **跨站唯一**：`source:nativeId`，去重、详情缓存、复排都靠它 |
| `source` / `sourceLabel` | 来源 id 与显示名 |
| `nativeId` / `id` | 站内 id（jobsdb 是数字，政府站是职位编号） |
| `title` / `company` / `salaryLabel` | 列表页就能拿到的字段 |
| `locations` / `workTypes` / `classifications` | 归一成字符串数组 |
| `listedAt` / `teaser` / `url` | 时间、摘要、原始链接 |
| `detail` | 有些站（政府站）搜索阶段就顺手把正文抓了，放这里 |

## 现状（2026-11-09）

| 来源 | 方式 | 结果 | 说明 |
|---|---|---|---|
| JobsDB | HTTP | ✅ 30 条/页，正文 1–3 KB | 列表 `api/jobsearch/v5/search`；正文 `POST /graphql` 的 `jobDetails.job.content` |
| 劳工处 jobs.gov.hk | 浏览器 | ✅ 3 条（关键词 "data analyst"；代码保留，未启用） | 必须带 `__RequestVerificationToken` + cookie；详情要 `x-requested-with: XMLHttpRequest`，否则返回整页搜索页 |
| CTgoodjobs | 浏览器 | ⏸ 已停用（代码保留） | AWS WAF「Human Verification」要人工过一次；且浏览器只能串行。要恢复：把 `ctgoodjobs` 加回 `ENABLED_SOURCE_IDS` |
| LinkedIn | 浏览器 | ⚠️ 本机被导向 linkedin.cn / 登录墙 | 换网络或先登录再试 |
| Indeed HK | 浏览器 | ⚠️ 返回 "Blocked - Indeed" | Cloudflare，基本要靠人工过验证 |

被挡的来源不会让整轮搜索失败：`/api/search` 的 `query.sourceStats` 里会写明 `blocked: true` 和原因，界面上显示「被拦」。

## 浏览器来源怎么工作

`bundle/lib/sources/browser.js` 是个**零依赖 CDP 驱动**：`spawn` 本机 Edge/Chrome，
连上 `webSocketDebuggerUrl`，`Page.navigate` → 等渲染 → `Runtime.evaluate` 取 `outerHTML`。
只用 Node 内置的 `fetch`、`WebSocket`、`node:child_process`，不装 puppeteer/playwright。

- 持久化 profile 在 `data/browser-profile/`（可用 `JOBMATCH_BROWSER_PROFILE` 覆盖）。
- 第一次遇到验证：`node bundle/bin/cli.mjs browser-login <站点>`（例如以后恢复的 `ctgoodjobs` / `linkedin`）
  会开一个**可见窗口**，你点一下验证，cookie 就留在 profile 里；窗口关掉即结束。
- 界面上的「过人工验证」按钮走的是同一个逻辑（`POST /api/browser-login`）。
- 浏览器路径可用 `JOBMATCH_BROWSER` 指定；否则自动找 Edge → Chrome。

## 加一个新站

1. 写一个文件 `bundle/lib/sources/<id>.js`，导出 `descriptor / search / fetchDetail`；
   如果是「渲染后按链接抽卡片」这种通用形态，直接用 `createBrowserSource({...})`（见 `sites.js`）。
2. 在 `bundle/lib/sources/index.js` 里把模块放进 `CATALOG`，再把 id 放进 `ENABLED_SOURCE_IDS`。
3. `node bundle/bin/selftest.mjs --live` 看它通不通；通了再在界面上勾选。

## 停用 / 恢复一个站

- **停用**：只从 `ENABLED_SOURCE_IDS` 删掉 id。搜索、界面、`/api/probe` 都不会再碰它；
  但模块还在 `CATALOG` 里，旧 run 的详情仍能打开（`fetchDetail` 按 `job.source` 找模块，不看启用列表）。
- **恢复**：把 id 加回 `ENABLED_SOURCE_IDS`，其他文件不用动。
- **真删**：才删 `CATALOG` 条目和 `sites.js` 里的配置。

`createBrowserSource` 只需要四样东西：`searchUrl(keywords)`、`linkPattern`（岗位链接正则）、
可选的 `blocked`（拦截页特征）、`home`。解析优先 JSON-LD（schema.org `JobPosting`），
没有就退回锚点文本；**解析不到就返回 0 条 + 原因，不编数据**。

## 完全离线

- 运行期没有 npm/pip 依赖：只有 Node 内置模块 + 本机浏览器。
- `bundle/data/fixtures/` 存了 2026-11-06 的真实响应（jobsdb 搜索 30 条、GraphQL 详情），
  断网也能验证解析逻辑没坏。
- `node bundle/bin/selftest.mjs` 跑离线自检（环境 / 解析 / 注册表，13 项）；
  加 `--live` 才联网逐站试一遍。

## 合规

- 只抓**雇主公开发布的职位**，不碰候选人资料与登录后数据。
- 默认 `REQUEST_GAP_MS = 1200`，单站单关键词最多 3 页；浏览器来源串行跑，不并发轰站。
- LinkedIn 用户协议明文禁止 bot（8.2 条），默认不勾选；要用请自担风险、低频、用求职小号。
- 抓下来的数据只落在本机 `data/`，不外传。
