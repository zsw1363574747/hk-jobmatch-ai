#!/usr/bin/env node
/**
 * 自检：先证明「不联网也能用」，再（可选）证明「联网真的通」。
 *
 *   node bundle/bin/selftest.mjs           # 离线：解析 fixtures + 环境检查
 *   node bundle/bin/selftest.mjs --live    # 额外逐站打一遍真站点（要几十秒）
 *
 * 为什么要离线那半：换一台机器、断网、或者站点改了版，先看是「代码坏了」
 * 还是「网络/站点坏了」。fixtures 是 2026-11-06 抓下来的真实响应。
 */
import { readFileSync } from 'node:fs'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSearch, parseDetail } from '../lib/sources/jobsdb.js'
import { cleanJobCard } from '../lib/sources/govhk.js'
import { parseSalaryLabel, salaryShort } from '../lib/domain/salary.js'
import { getSource, isEnabled, listSources, normalizeSourceIds, probeSources } from '../lib/sources/index.js'
import { browserStatus } from '../lib/sources/browser.js'
import { classifyLoginPage } from '../lib/sources/session.js'
import { locationGroups } from '../lib/domain/locations.js'
import { filterJobs } from '../lib/domain/match.js'
import { bisectRange } from '../lib/features/salary/precise.js'
import { buildInsight } from '../lib/features/insight/build.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', 'data', 'fixtures')
const results = []
const live = process.argv.includes('--live')

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
}

function readFixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

console.log('== 环境 ==')
const major = Number(process.versions.node.split('.')[0])
check('Node >= 22（内置 WebSocket / fetch / AbortSignal.timeout）', major >= 22, `v${process.versions.node}`)
const browser = browserStatus()
check('找到 Edge / Chrome（浏览器来源要用）', browser.ok, browser.ok ? browser.executable : browser.hint)

const dir = await mkdtemp(join(tmpdir(), 'jobmatch-selftest-'))
try {
  await access(dir)
  check('临时目录可写', true, dir)
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log('\n== 离线解析（fixtures） ==')
let searchJobs = []
try {
  const parsed = normalizeSearch(JSON.parse(readFixture('jobsdb-search.json')))
  searchJobs = parsed.jobs
  check('JobsDB 搜索 JSON → Job[]', parsed.jobs.length > 0, `${parsed.jobs.length} 条 / total ${parsed.totalCount}`)
  check('每条都带跨站唯一 key', parsed.jobs.every((job) => String(job.key).startsWith('jobsdb:')), parsed.jobs[0]?.key ?? '')
  check('字段映射（标题/公司/URL）', Boolean(parsed.jobs[0]?.title && parsed.jobs[0]?.url), parsed.jobs[0]?.title ?? '')
} catch (error) {
  check('JobsDB 搜索 JSON → Job[]', false, String(error?.message ?? error))
}

try {
  const payload = JSON.parse(readFixture('jobsdb-detail.json'))
  const detail = parseDetail(payload)
  check('JobsDB GraphQL → JD 正文', detail.ok && detail.detail.contentChars > 200, `${detail.detail?.contentChars ?? 0} 字`)
  check('正文来源标为 graphql（不再退 teaser）', detail.detail?.source === 'graphql', detail.detail?.source ?? '')
} catch (error) {
  check('JobsDB GraphQL → JD 正文', false, String(error?.message ?? error))
}

const govSample = `Clip this Job
 Print
 Points-to-Note
 Job Card
 List View
 Vacancies:
 1
 No.:
 22-26-0021197 CM
 Date:
 29/10/2026
 Job Title:
 Analyst Programmer - AI
 Company / Employer Name:
 AMI PERSONNEL CONSULTANTS CO
 District:
 Lai Chi Kok
 Responsibilities:
 Integrate AI agents with ERP.
 Requirements :
 Bachelor Degree; 1 year of experience
 Employment Terms:
 $25,000 - $30,000 per month
 Application Information:
 e-mail resume to ami@example.com
 Remarks:
 -
 Next Job
 Points-to-Note
 How to Apply?
 Note for Job Seekers:
 一大堆样板文字`
const cleaned = cleanJobCard(govSample)
check('政府职位卡清洗（去掉导航与法例样板）', cleaned.startsWith('No.:') && cleaned.includes('Requirements'), `${cleaned.length} 字`)
check('政府职位卡能抽到雇主名', /Company \/ Employer Name:\s*\n?\s*AMI/.test(cleaned), '')
check('政府职位卡不再包含尾部样板', !cleaned.includes('Note for Job Seekers'), '')

console.log('\n== 薪资解析 ==')
{
  const cases = [
    ['$28,000 – $35,000 per month', 28000, 35000, 'month'],
    ['$45k - $55k p.m.', 45000, 55000, 'month'],
    ['30k-40k/month', 30000, 40000, 'month'],
    ['$18,000  per month', 18000, 18000, 'month'],
    ['$42k - $55k p.a.', 42000, 55000, 'year'],
  ]
  let ok = true
  for (const [label, min, max, period] of cases) {
    const parsed = parseSalaryLabel(label)
    const good = parsed && parsed.min === min && parsed.max === max && parsed.period === period
    if (!good) {
      ok = false
      console.log(`  FAIL ${label} -> ${JSON.stringify(parsed)}`)
    }
  }
  check('明码薪资解析（5 种写法）', ok, `${cases.length} 个样例`)
  check('「面议 / NA」不瞎猜', parseSalaryLabel('Negotiable') === null && parseSalaryLabel('NA') === null, '')
  const bonus = parseSalaryLabel('$35k - $40k p.m. + Double Pay')
  check('花红单独挂 bonus', Boolean(bonus?.bonus), bonus?.bonus ?? '')
  check('短文本 28–35K', salaryShort({ min: 28000, max: 35000, mid: 31500, period: 'month', kind: 'explicit' }) === '28–35K', '')
}

console.log('\n== 精确薪资二分 ==')
{
  // 假数据：真实区间 250,000–300,000，看二分能不能把上下边界各卡到 1,000。
  const result = await bisectRange({
    low: 200000,
    high: 400000,
    badgeAt: async (value) => value >= 250000 && value <= 300000,
  })
  check(
    '二分上下边界（假数据）',
    result.ok && result.min === 250000 && result.max === 300000,
    `${result.min}-${result.max} / ${result.checks} 次`,
  )
}

console.log('\n== 登录页判定 ==')
{
  // 正常页也会加载 Cloudflare 的 challenge-platform 脚本；不能因此判成验证页。
  const normal = `<title>Jobsdb - Hong Kong</title><script src="https://hk.jobsdb.com/cdn-cgi/challenge-platform/scripts/precursor/main.js"></script><a data-automation="sign in">Sign in</a>`
  let page = classifyLoginPage(normal)
  check('正常页面不被误判成 Cloudflare 验证页', page.blocked === false && page.loggedIn === false, page.blocked ? '误判 blocked' : 'ok')

  page = classifyLoginPage('<title>Just a moment...</title><div id="cf-chl-widget"></div>')
  check('真正的验证页仍识别为 E_BLOCKED', page.blocked === true, '')

  page = classifyLoginPage('<nav data-automation="account menu">My profile</nav>')
  check('登录态：account menu → 已登录', page.loggedIn === true, '')

  // 2026-11 的登录页头部：account name + sign out，同时残留隐藏的 sign-in-register。
  page = classifyLoginPage('<header data-automation="account name">Sam</header><a data-automation="sign-in-register">Sign in</a><a>Sign out</a>')
  check('登录态：account name 优先于残留的 sign-in-register', page.loggedIn === true, '')
}

console.log('\n== 来源注册表 ==')
const sources = listSources()
check('只启用 JobsDB', sources.length === 1 && sources[0]?.id === 'jobsdb', sources.map((item) => item.id).join(','))
check('HTTP 来源不需要浏览器', sources[0]?.needsBrowser === false, '')
check('CTgoodjobs 停用但保留适配器', isEnabled('ctgoodjobs') === false && getSource('ctgoodjobs')?.descriptor?.needsBrowser === true, '代码保留，未启用')
check('停用来源的搜索请求被忽略', normalizeSourceIds(['ctgoodjobs']).join(',') === 'jobsdb', normalizeSourceIds(['ctgoodjobs']).join(','))

console.log('\n== 地点 / 硬筛 ==')
const groups = locationGroups()
const flat = groups.flatMap((group) => group.items)
check(
  '地点分组：热门在前 + 港岛/九龙/新界',
  groups[0]?.id === 'hot' && ['hki', 'kln', 'nte'].every((id) => groups.some((group) => group.id === id)),
  groups.map((group) => `${group.label}${group.items.length}`).join(' / '),
)
check('地点值不重复', new Set(flat.map((item) => item.value)).size === flat.length, `${flat.length} 个`)
const sampleJobs = [
  { title: 'A', locations: ['Central, Central and Western District'], workTypes: ['Full time'] },
  { title: 'B', locations: ['Sha Tin District'], workTypes: ['Part time'] },
  { title: 'C', locations: ['Central, Central and Western District'], workTypes: ['Part time'] },
]
const filtered = filterJobs(sampleJobs, { locations: ['Central'], workTypes: ['Part time'] })
check(
  '地点 + 工作类型硬筛（没简历也生效）',
  filtered.jobs.length === 1 && filtered.jobs[0].title === 'C',
  `留 ${filtered.jobs.length} 条，丢 location=${filtered.dropped.location} workType=${filtered.dropped.workType}`,
)

console.log('\n== JD 要求排行 ==')
{
  const detail = (text) => ({ contentText: text, contentChars: text.length })
  const runA = {
    runId: 'r-test-a',
    jobs: [
      { id: '1', key: 'jobsdb:1', company: 'A' },
      { id: '2', key: 'jobsdb:2', company: 'B' },
    ],
    details: {
      'jobsdb:1': detail('About us: a small team that likes gadgets and Go.\n\nRequirements:\nStrong SQL and Excel. Excel pivots, dashboards and ad hoc reporting for stakeholders in three regions.'),
      'jobsdb:2': detail('Our stack: Python and Go for services.\n\nRequirements:\nExcel modelling for weekly business reviews, plus dashboards and reporting packs for the leadership team.'),
    },
  }
  const single = buildInsight(runA)
  const byLabel = (insight, label) => insight.terms.find((term) => term.label === label)
  const excel = byLabel(single, 'Excel')
  check('要求段落：两条 JD 都提到 Excel（100%）', excel?.count === 2 && excel?.pct === 100, `count=${excel?.count} pct=${excel?.pct}`)
  check('要求段落：只在前言出现的词不计入', !byLabel(single, 'Python'), 'Python 在 Requirements 之前')
  const sql = byLabel(single, 'SQL')
  check('占比按「命中的 JD / 总 JD」算（1/2 = 50%）', sql?.count === 1 && sql?.pct === 50, `count=${sql?.count} pct=${sql?.pct}`)
  const merged = buildInsight([
    runA,
    { runId: 'r-test-b', jobs: [{ id: '1', key: 'jobsdb:1', company: 'A' }], details: { 'jobsdb:1': detail('Requirements:\nSQL only, nothing else worth mentioning here at all, really nothing.') } },
  ])
  check('跨 run 合并按岗位去重', merged.jdCount === 2 && merged.runCount === 2, `jdCount=${merged.jdCount} runCount=${merged.runCount}`)
  check(
    '学历 / 语言不进能力排行',
    !single.terms.some((term) => ['学历要求', 'English', 'Mandarin', 'Cantonese'].includes(term.label)) && Array.isArray(single.context),
    `terms=${single.terms.length} context=${single.context.length}`,
  )
  const withContext = buildInsight({
    runId: 'r-test-c',
    jobs: [{ id: '3', key: 'jobsdb:3', company: 'C' }],
    details: {
      'jobsdb:3': detail('Requirements:\nBachelor degree in Business, English and Mandarin required, plus strong SQL and Excel skills for reporting.'),
    },
  })
  check(
    '学历 / 语言只出现在背景行',
    withContext.context.some((item) => item.label === '学历要求') && !withContext.terms.some((term) => term.label === 'English'),
    `context=${withContext.context.map((item) => `${item.label}:${item.pct}%`).join('/')}`,
  )
  check('能力按 5 个分组返回', single.groups.length > 0 && single.groups.every((group) => Array.isArray(group.terms)), single.groups.map((group) => group.label).join(' / '))
  const withSkills = buildInsight({
    runId: 'r-test-d',
    profile: { skills: ['Excel'] },
    jobs: [{ id: '4', key: 'jobsdb:4', company: 'D' }],
    details: {
      'jobsdb:4': detail('Requirements:\nExcel and SQL for reporting, dashboards, and weekly business reviews across all regions in the team.'),
    },
  })
  check(
    '区分「简历已有」和「缺口」',
    withSkills.terms.find((term) => term.label === 'Excel')?.have === true &&
      withSkills.gaps.some((gap) => gap.label === 'SQL') &&
      !withSkills.gaps.some((gap) => gap.label === 'Excel'),
    `covered=${withSkills.covered}/${withSkills.rankedCount} gaps=${withSkills.gaps.map((gap) => gap.label).join('/')}`,
  )
  check(
    '总结说清「为什么 + 结论」',
    typeof single.summary?.headline === 'string' &&
      single.summary.headline.includes(single.terms[0].label) &&
      single.summary.why.length >= 3 &&
      single.summary.conclusion.length >= 2,
    `why=${single.summary?.why.length} conclusion=${single.summary?.conclusion.length}`,
  )
}

if (live) {
  console.log('\n== 联网自检（每个来源真打一次） ==')
  const rows = await probeSources({})
  for (const row of rows) {
    const label = row.ok ? `通 (${row.count} 条)` : row.blocked ? '被拦（需要人工验证或换网络）' : '不通'
    const ok = row.ok || row.blocked
    check(`${row.label}：${label}`, ok, `${row.ms}ms${row.note ? ` · ${row.note.slice(0, 80)}` : ''}`)
  }
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} · ${results.length} checks${live ? ' · live' : ' · offline'}`)
if (failed.length > 0) {
  for (const row of failed) console.log(`  FAIL: ${row.name} ${row.detail}`)
  process.exitCode = 1
}
