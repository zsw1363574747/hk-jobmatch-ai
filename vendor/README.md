# vendor/ · 这个文件夹里有什么、为什么不需要联网装东西

jobmatch 运行期**不装任何包**。这里的「完全下载」指的是：

1. 解析逻辑全部是本仓库自己的代码（`bundle/lib/sources/*`），不是运行时 `pip/npm install`；
2. 站点响应的真实样本存在 `bundle/data/fixtures/`，断网也能跑自检；
3. 浏览器用**本机已装的** Edge/Chrome，通过 CDP 驱动，不需要下载 Chromium；
4. 没有任何 CDN / 远程服务依赖，页面只加载本地的 `styles.css` 与 `app.js`。

## 参考过的公开实现（只借思路，代码是自己写的）

| 项目 | 借了什么 |
|---|---|
| [MetaDotHK/jobsdb-scraper](https://github.com/MetaDotHK/jobsdb-scraper) | JobsDB `/api/jobsearch/v5/search` 的参数与分页上限（page ≤ 1000、pageSize 实际 30） |
| [IkerGoni/jobsdb-wrapper](https://github.com/IkerGoni/jobsdb-wrapper) | SEEK 的 GraphQL 端点、`x-custom-features` 头、`JobSearchV7` / `JobDetail` 的操作形状 |
| [prui0474/hk-job-radar](https://github.com/prui0474/hk-job-radar) | 持久化浏览器 profile + 人工过验证、单站配额/随机延迟的克制策略 |
| [wit3k/jobsdb_details_fetch_firefox_plugin](https://github.com/wit3k/jobsdb_details_fetch_firefox_plugin) | 「JSON-LD → 内嵌数据 → DOM」三层兜底的解析顺序 |
| [JJ-Jacko/jobs_hk](https://github.com/JJ-Jacko/jobs_hk) | 劳工处 `jobs.gov.hk` 的 `jobCard` 路径与 `order` 参数形式 |

这些项目的许可证各不相同（多为 MIT）。本项目**没有拷贝它们的源码**，只按公开接口/页面结构重写；
如果之后要直接搬代码，请先看对应仓库的 LICENSE。

## 离线自检用到的东西

```
bundle/data/fixtures/jobsdb-search.json   # 2026-11-06 的真实 v5 搜索响应（30 条）
bundle/data/fixtures/jobsdb-detail.json   # 同一天的 GraphQL 详情响应（含 JD HTML）
bundle/bin/selftest.mjs                   # 13 项离线检查；--live 才联网
```

fixtures 里是**公开招聘信息**，不含任何候选人/个人数据。重新抓一份：

```bat
node --use-system-ca bundle\bin\capture-fixtures.mjs
```

（`capture-fixtures.mjs` 会覆盖上面两个文件；只在需要更新样本时跑。）
