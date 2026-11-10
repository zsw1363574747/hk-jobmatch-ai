# jobmatch 架构（v0.8.0，2026-11-09 重构后）

> 目标：**一个功能一块代码；run 是唯一事实来源；latest 只是只读投影。**
> 旧的 `service.js` 上帝模块、`report.js` 双重映射、`app.js` 单文件都已拆掉。

---

## 1. 目录

```
bundle/
  bin/
    cli.mjs                 # 命令入口：resume/search/jobs/salary/report/...
    selftest.mjs            # 离线解析自检
    architecture-test.mjs   # 数据不变量测试
  lib/
    domain/                 # 纯业务对象，不碰 fs / net / DOM
      job.js                # jobKey / findJob / normalizeJob / applyDetailToJob
      salary.js             # 薪资解析 + normalizeSalary / salaryShort
      experience.js         # 年限抽取 + 比较
      match.js              # 七项加权 + 经验门槛 + 硬筛（过期 / 地点 / 类型）
      locations.js          # 香港地点分组（热门 / 港岛 / 九龙 / 新界）
      profile.js            # years 归一
      run.js                # createRunId / rescoreRun / assertRun
    features/               # 一个功能一个目录
      resume/
        service.js          # 简历文本/PDF/docx 解析 → 画像
        understanding.js    # 简历理解：经历、成果、关键词
        pdf.js              # 零依赖 PDF 文本抽取
        lexicon.js          # 技能/职位词表匹配
      search/
        service.js          # 关键词 → 来源 → 去重 → 排序 → run
        rescore.js          # 改权重/年限后重排
      details/
        service.js          # 抓 JD、合并详情；不重算、不排序
        attach-jd.js        # 手动贴 JD（显式命令，允许重排）
      salary/
        service.js          # 明码 + 探针 + 徽章 + 精确二分
        probe.js            # JobsDB salaryrange 探针
        precise.js          # 用 Salary match 徽章二分岗位薪资（会临时改期望薪资）
        report.js           # 关键词薪酬分布
      report/
        project.js          # run → 页面 DTO（纯函数）
        markdown.js         # page DTO → Markdown
        service.js          # 报告命令：写 latest + report.md
      news/
        service.js
        source.js           # Google News RSS
      translate/
        service.js
        source.js           # 翻译 + 缓存
      insight/
        service.js          # dispatch：scope=run 单轮 / scope=all 合并 data/runs 全部轮次
        build.js            # 能力统计（lexicon 词表 + 要求段落 + 占比 + 5 个能力分组 + 简历缺口）
      sources/service.js    # sources / probe / session / browserLogin
      locations/service.js  # GET /api/locations：地点选项（静态数据）
    sources/                # 来源适配器（当前启用 JobsDB；CTgoodjobs 停用保留）
      index.js              # CATALOG + ENABLED_SOURCE_IDS + 并行搜索 + 去重 + 详情分发
      jobsdb.js
      browser.js
      browser-site.js
      sites.js
      session.js
      govhk.js
    storage/                # 只有这里能写文件
      run-store.js          # runs/<runId>.json：读/写/更新
      page-store.js         # latest.json：投影；带 guardRunId
      report-store.js       # runs/<runId>.report.md
    # 公共小模块在 lib 根：
    # constants.js / errors.js / text.js / net.js / concurrency.js / memory.js / jobsdb.js
    service.js              # 兼容 facade：只做错误记忆 + 统一导出
web/
  server.mjs                # 启动 + 静态文件
  http/
    context.mjs             # token/auth/body/upload/runCli/serveStatic
    router.mjs              # 路由表 + 方法/权限/错误
  routes/                   # 一个功能一个路由文件
    system.mjs              # health/sources/probe/session/latest/translations
    profile.mjs             # profile/runs
    resume.mjs              # resume/upload
    search.mjs              # search/rescore
    jobs.mjs                # jobs/jd/translate/news/insight/salary/salary-report
    report.mjs              # report + report.md
  public/
    index.html
    app.js                  # 只做启动 + 搜索/洞察/导出/来源
    js/
      core.js               # state/api/token/helpers/事件总线
      results.js            # 列表/经验/薪资标签/计数
      detail.js             # 详情面板/薪资探针/新闻/翻译/粘贴 JD
      resume.js             # 简历解析/理解/上传
      weights.js            # 匹配比例/经验年限/重排
      salary-report.js      # 关键词薪酬参考
```

**规则：**

- `features/*` 只能 import `domain/*`、`storage/*`、`sources/*`、`lib` 根公共模块；不能 import 另一个 feature 的内部文件。
- `domain/*` 不 import `features/*`、`storage/*`、`net`、`fs`。
- `storage/*` 只认 schema，不含业务判断。
- 一个功能一个目录：`service`、`route`、`ui`、`test` 放在一起。
- HTTP 层只做输入输出，不写业务逻辑。

---

## 2. 数据规则

1. **`data/runs/<runId>.json` 是唯一事实来源。**
   - `search` 创建 run；
   - `details` 只写 `run.details` 和对应 job 的正文/经验/薪资；
   - `salary` 只写这一条 job 的 salary；
   - `rescore` 是唯一会重排全部 job 的命令；
   - `report` 只读 run，生成 page + markdown。

2. **`data/latest.json` 只是页面投影。**
   - 由 `projectRun(run)` 生成；
   - 只允许 `page-store.writePage` 写；
   - 写的时候带 `guardRunId`：如果当前 latest 已经属于另一轮，就不覆盖；
   - 任何命令不能拿 latest 当输入再 patch。

3. **salary 只有一种形状：**
   ```js
   null | {
     kind: 'explicit' | 'probed',
     min, max, mid, period, currency,
     salaryText, evidence, ...
   }
   ```
   字符串在 `normalizeSalary()` 里统一转对象；`salaryText` 由 `salaryShort()` 生成，前后端不各自拼。

4. **读接口不写数据。**
   - `GET /api/latest`、`GET /api/runs`、`GET /api/profile` 不产生写操作。
   - `POST /api/jobs` 是详情命令，只写 run.details；**不重算分数、不排序**。
   - 打开一条岗位不会改变列表分数；要改分数必须走 `POST /api/rescore`。

5. **来源能力显式声明。**
   - 薪资探针只在 `salary` feature 里判断 `source === 'jobsdb'`；
   - 前端不硬编码来源 ID，只按后端返回的 `salary` / `source` 展示。

6. **画像年限只归一一次。**
   - `domain/profile.js` 的 `normalizeYears` / `resolveProfileYears`；
   - `search` 收到 profile 后归一，run 里存快照；
   - UI 的「我的经验年限」是显式覆盖，`rescore` 时写进 run.profile。

7. **发布时间窗口只影响展示，不过滤数据。**
   - `search` 把 `postedWithinWeeks`（默认 4，1–52）写进 `run.query`；
   - 前端用 `listedAt` 和当前窗口比较，超过窗口的岗位仍保留，公司名加 `.company-stale` 标红；
   - 没有 `listedAt` 的岗位不标红（发布时间未知），悬停可看提示。

---

## 3. 前端数据流

```
GET /api/latest ──► applyRun(page) ──► renderRows / updateCounts
                                      └─ emit('run-applied') → setWeightsFromRun
                                      └─ 若已有 JD 详情，静默 applyWeights(quiet) → 重排一次

搜索 ──► applyRun(page) ──► renderRows / updateCounts
                            └─ emit('run-applied') → setWeightsFromRun
                            └─ hydrateDetails（分批 POST /api/jobs）
                                 └─ 补全完成后 applyWeights({silent}) → POST /api/rescore → 自动重排一次

点击一行 ──► emit('open-job') → openDetail(job)
             └─ POST /api/jobs (只合并详情) → 重新渲染这一条；不重排
             └─ POST /api/salary（仅 jobsdb + 无明码）→ 更新列表这一行

改权重/年限 ──► POST /api/rescore → renderRows / updateCounts
```

- `core.js` 是唯一共享状态（`state`）和 API/token；
- `results.js` 不 import `detail.js`，通过事件总线解耦；
- `detail.js` 可以 import `results.js`（刷新列表），反向不允许；
- `detail.js` 只 import `weights.js` 的 `applyWeights`，用于“补全完成后自动重排”这一次；
- `resume.js` / `weights.js` / `salary-report.js` 互不依赖。

---

## 4. 测试

```bat
:: 离线解析 17 项
node bundle\bin\selftest.mjs

:: 数据不变量 10 项（salary 类型 / 投影幂等 / page guard / run 缺失提示 / 贴 JD / rescore）
node bundle\bin\architecture-test.mjs

:: 浏览器端到端（会真的搜索一次，建议用临时 data 目录）
:: 打开 http://127.0.0.1:7790/?selftest=1
```

浏览器自检会走完：解析简历 → 搜索 → 详情 → 重排 → 导出报告，并在页面标题写 `SELFTEST OK`。

---

## 5. 加一个新功能

以「公司新闻」为例：

1. `bundle/lib/features/news/service.js`：只暴露 `news(company, options)`；
2. `web/routes/jobs.mjs` 里加一条 `GET /api/news`；
3. `web/public/js/features/news.js`：只负责渲染和请求；
4. 在 `app.js` 或 `detail.js` 里调用，不把新闻逻辑塞进 `service.js`。

**不要做：**

- 不要在 `service.js` 里加业务逻辑（它只是 facade）。
- 不要在 `web/server.mjs` 里加 if 分支（加到 `web/routes/*.mjs`）。
- 不要在 `app.js` 里加新的全局函数（加到 `web/public/js/*.js`）。
- 不要让 `details` 命令重算分数。
- 不要直接把 `latest.json` 当数据源改。
