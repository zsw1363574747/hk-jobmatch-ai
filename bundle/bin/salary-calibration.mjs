/**
 * 薪酬反查 · 精度校准（离线脚本，可重复跑）
 *
 * 做什么：
 *   1) 用若干关键词搜 JobsDB，挑出**雇主公开了薪资**（salaryLabel 有值、月薪、数值合理）的岗位；
 *   2) 把这些岗位当成「已知答案」，用点开岗位时同一套平台筛选探针（公司名 + salaryrange 逐档查）
 *      反推它们的薪资——全程不看答案、不加先验，和线上路径一致；
 *   3) 把反推结果和真值对比，给出：能不能探到（覆盖率）、区间中点误差、真值是否落在反推区间、
 *      命中档位形状、按薪资段拆分，以及失败原因。
 *
 * 目的：回答「用公开薪酬的岗位当标尺，平台筛选反查到底准不准」，
 *      并让 docs/salary-inference.md 里的精度说法有可复现的数字。
 *
 * 用法（在项目根目录）：
 *   node bundle\bin\salary-calibration.mjs
 *   node bundle\bin\salary-calibration.mjs --keywords "data analyst,accountant" --pages 2 --limit 80
 *   node bundle\bin\salary-calibration.mjs --gap 300 --out data/salary-calibration.json
 *
 * 注意：只读公开搜索接口，不登录、不写 run；结果落一个 JSON，不动线上数据。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SEARCH_BASE, SITE_KEY, SOURCE_SYSTEM } from '../lib/constants.js'
import { fetchText } from '../lib/net.js'
import { parseSalaryLabel, toMonthly, isSaneMonthly } from '../lib/domain/salary.js'
import { PROBE_BANDS, PROBE_TOP_BAND, reconstruct } from '../lib/features/salary/probe.js'

// ---------- 参数 ----------
function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value == null || value.startsWith('--') ? fallback : value
}
function argNumber(name, fallback) {
  const value = Number(argValue(name, ''))
  return Number.isFinite(value) ? value : fallback
}

const DEFAULT_KEYWORDS = [
  'data analyst',
  'accountant',
  'product manager',
  'marketing executive',
  'software engineer',
  'human resources',
  'sales manager',
  'customer service',
  'administration officer',
  'business analyst',
]
const KEYWORDS = String(argValue('keywords', DEFAULT_KEYWORDS.join(',')))
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const PAGES = Math.max(1, Math.min(3, argNumber('pages', 2))) // 每个关键词抓几页候选
const LIMIT = Math.max(10, Math.min(200, argNumber('limit', 90))) // 最多校准多少条
const GAP_MS = Math.max(80, Math.min(2000, argNumber('gap', 220))) // 请求间隔
const OUT = argValue('out', join('data', 'salary-calibration.json'))
const PROBE_PAGE_LIMIT = 3 // 与线上探针一致：每档最多翻 3 页（90 条）
const MAX_COMPANY_ADS = PROBE_PAGE_LIMIT * 30 // 公司广告数超过 90 条，探针翻不完 → 不纳入

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let requestCount = 0
let errorCount = 0

// ---------- 取数 ----------
function searchUrl(keyword, page) {
  const url = new URL(SEARCH_BASE)
  url.searchParams.set('siteKey', SITE_KEY)
  url.searchParams.set('sourcesystem', SOURCE_SYSTEM)
  url.searchParams.set('keywords', keyword)
  url.searchParams.set('page', String(page))
  url.searchParams.set('pageSize', '30')
  return url.toString()
}

function bandUrl(keyword, band, page) {
  const url = new URL(searchUrl(keyword, page))
  url.searchParams.set('salarytype', 'monthly')
  url.searchParams.set('salaryrange', `${band[0]}-${band[1]}`)
  return url.toString()
}

async function getJson(url, attempts = 2) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      requestCount += 1
      const text = await fetchText(url, {
        headers: { accept: 'application/json, text/plain, */*', referer: 'https://hk.jobsdb.com/' },
      })
      return JSON.parse(text)
    } catch (error) {
      lastError = error
      errorCount += 1
      await sleep(700 + attempt * 900)
    }
  }
  throw lastError
}

/** 公司名不可用时退回标题（与线上 probeKeyword 同一规则）。 */
function probeKeywordFor(job) {
  const company = String(job.company ?? '').trim()
  const bad = /^(confidential|private|n\/?a|na|unknown|client|our client|某公司)$/i
  if (company && company.length >= 2 && !bad.test(company)) return company
  return String(job.title ?? '').trim()
}

/** 校准只接受「能用公司名探」的样本：拿标题当关键词会命中上千条，翻不完也说明不了问题。 */
function hasUsableCompany(company) {
  const value = String(company ?? '').trim()
  const bad = /^(confidential|private|n\/?a|na|unknown|client|our client|某公司)$/i
  return value.length >= 2 && !bad.test(value)
}

/** 公开薪资是否适合当「真值」：月薪、量级合理、不是离谱宽区间（如 50k–650k）。 */
function truthOf(label) {
  const parsed = parseSalaryLabel(label)
  if (!parsed || parsed.period !== 'month') return null
  const monthly = toMonthly(parsed)
  if (!isSaneMonthly(monthly)) return null
  if (monthly.min == null || monthly.max == null) return null
  if (monthly.min < 5000 || monthly.max > 200000) return null
  if (monthly.max / monthly.min > 3) return null
  return monthly
}

// ---------- 1. 收集「公开薪资」样本 ----------
async function collectSample() {
  const found = new Map()
  for (const keyword of KEYWORDS) {
    for (let page = 1; page <= PAGES; page += 1) {
      if (page > 1) await sleep(GAP_MS)
      let json
      try {
        json = await getJson(searchUrl(keyword, page))
      } catch {
        console.log(`  [warn] 采样失败 ${keyword} p${page}`)
        break
      }
      for (const item of json.data ?? []) {
        const id = String(item.id ?? '')
        if (id === '') continue
        const truth = truthOf(item.salaryLabel)
        if (!truth) continue
        const job = {
          id,
          keyword,
          title: String(item.title ?? ''),
          company: String(item.companyName ?? ''),
          salaryLabel: String(item.salaryLabel ?? ''),
          truth,
          probeKeyword: probeKeywordFor({ company: item.companyName, title: item.title }),
        }
        const fingerprint = `${job.company}|${job.title}|${truth.min}|${truth.max}`
        if (!found.has(fingerprint)) found.set(fingerprint, job) // 同一岗位重复投放在不同关键词下只留一条
      }
      if (found.size >= LIMIT * 2) break
    }
    console.log(`  [sample] ${keyword} → 累计 ${found.size} 条可校准样本`)
    if (found.size >= LIMIT * 2) break
  }
  return [...found.values()].slice(0, LIMIT)
}

// ---------- 2. 检验岗位是否还在、公司是否可探 ----------
async function inspectCompanies(jobs) {
  const groups = new Map()
  for (const job of jobs) {
    if (!groups.has(job.probeKeyword)) groups.set(job.probeKeyword, [])
    groups.get(job.probeKeyword).push(job)
  }
  const result = []
  for (const [keyword, group] of groups) {
    if (group.every((job) => !hasUsableCompany(job.company))) {
      result.push({ keyword, group, skip: 'E_NO_COMPANY' })
      continue
    }
    let total = 0
    const present = new Set()
    try {
      const first = await getJson(searchUrl(keyword, 1))
      total = Number(first.totalCount) || 0
      for (const item of first.data ?? []) present.add(String(item.id))
    } catch {
      result.push({ keyword, group, skip: 'E_NETWORK' })
      continue
    }
    if (total > MAX_COMPANY_ADS) {
      result.push({ keyword, group, total, skip: `E_TOO_MANY_ADS(${total})` })
      continue
    }
    const pages = Math.min(PROBE_PAGE_LIMIT, Math.max(1, Math.ceil(total / 30)))
    for (let page = 2; page <= pages; page += 1) {
      if (present.size >= group.length) break
      await sleep(GAP_MS)
      try {
        const json = await getJson(searchUrl(keyword, page))
        for (const item of json.data ?? []) present.add(String(item.id))
      } catch {
        break
      }
    }
    const alive = group.filter((job) => present.has(job.id))
    const gone = group.filter((job) => !present.has(job.id))
    result.push({ keyword, group, total, alive, gone })
    await sleep(GAP_MS)
  }
  return result
}

// ---------- 3. 盲探：和线上 probeSalary 一样，从 10k 问到 60k+ ----------
async function probeCompany(entry) {
  const bands = [...PROBE_BANDS, PROBE_TOP_BAND]
  const hits = new Map(entry.alive.map((job) => [job.id, []]))
  const bandTotals = []
  let truncated = false

  for (const band of bands) {
    let page = 1
    let bandTotal = 0
    // 每档单独记「这一档里还没找到的岗位」：同一条岗位会在多档出现，不能跨档复用。
    const pending = new Set(entry.alive.map((job) => job.id))
    while (page <= PROBE_PAGE_LIMIT) {
      let json
      try {
        json = await getJson(bandUrl(entry.keyword, band, page))
      } catch {
        break
      }
      bandTotal = Number(json.totalCount) || 0
      for (const item of json.data ?? []) {
        const id = String(item.id)
        if (pending.delete(id)) hits.get(id).push(band)
      }
      if (pending.size === 0) break
      if ((json.data ?? []).length === 0 || page * 30 >= bandTotal) break
      page += 1
      await sleep(GAP_MS)
    }
    bandTotals.push({ band: `${band[0] / 1000}-${band[1] / 1000}k`, total: bandTotal })
    if (bandTotal > PROBE_PAGE_LIMIT * 30 && pending.size > 0) truncated = true
    await sleep(GAP_MS)
  }
  return { hits, bandTotals, truncated }
}

// ---------- 4. 统计 ----------
function percentile(values, q) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[index]
}

const BUCKETS = [
  [10000, 15000], [15000, 20000], [20000, 25000], [25000, 30000], [30000, 35000],
  [35000, 40000], [40000, 45000], [45000, 50000], [50000, 55000], [55000, 60000], [60000, 200000],
]

function bucketOf(mid) {
  const bucket = BUCKETS.find(([low, high]) => mid >= low && mid < high)
  return bucket ? `${bucket[0] / 1000}-${bucket[1] / 1000}k` : 'other'
}

function summarize(rows) {
  const probed = rows.filter((row) => row.hitBands.length > 0)
  const scored = probed.filter((row) => !row.estimate.openEnded && !row.truthOver60)
  const absPct = scored.map((row) => Math.abs(row.midPctErr))
  const signed = scored.map((row) => row.midPctErr)
  const widthRatios = scored
    .filter((row) => row.estimate.max != null)
    .map((row) => (row.estimate.max - row.estimate.min) / (row.truth.max - row.truth.min || 1))

  const byBucket = new Map()
  for (const row of probed) {
    const key = bucketOf(row.truth.mid)
    if (!byBucket.has(key)) byBucket.set(key, [])
    byBucket.get(key).push(row)
  }

  return {
    collected: rows.length,
    probed: probed.length,
    coverage: rows.length === 0 ? 0 : probed.length / rows.length,
    scored: scored.length,
    midInRate: scored.length === 0 ? 0 : scored.filter((row) => row.midIn).length / scored.length,
    overlapRate: scored.length === 0 ? 0 : scored.filter((row) => row.overlap).length / scored.length,
    medianAbsPctErr: percentile(absPct, 0.5),
    p90AbsPctErr: percentile(absPct, 0.9),
    medianSignedPctErr: percentile(signed, 0.5),
    within10: scored.filter((row) => Math.abs(row.midPctErr) <= 0.1).length / Math.max(1, scored.length),
    within15: scored.filter((row) => Math.abs(row.midPctErr) <= 0.15).length / Math.max(1, scored.length),
    within20: scored.filter((row) => Math.abs(row.midPctErr) <= 0.2).length / Math.max(1, scored.length),
    medianWidthRatio: percentile(widthRatios, 0.5),
    byBucket: [...byBucket.entries()]
      .map(([bucket, list]) => {
        const ok = list.filter((row) => !row.estimate.openEnded)
        const errors = ok.map((row) => Math.abs(row.midPctErr))
        return {
          bucket,
          n: list.length,
          midIn: ok.length === 0 ? null : ok.filter((row) => row.midIn).length / ok.length,
          medianAbsPctErr: percentile(errors, 0.5),
        }
      })
      .sort((left, right) => parseFloat(left.bucket) - parseFloat(right.bucket)),
  }
}

// ---------- 5. 主流程 ----------
/** 明细 CSV（带 BOM，Excel 打开中文不乱码）。 */
function toCsv(rows) {
  const esc = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
  const header = ['公司', '职位', '公开薪资', '反推区间', '中点误差', '命中档位', '招聘关键词']
  const lines = [header.join(',')]
  for (const row of rows) {
    const estimate = row.estimate.openEnded
      ? '60K+'
      : row.estimate.min == null
        ? ''
        : `${row.estimate.min}-${row.estimate.max}`
    lines.push(
      [
        esc(row.company),
        esc(row.title),
        esc(`${row.truth.min}-${row.truth.max}`),
        esc(estimate),
        esc(row.midPctErr == null ? '' : `${(row.midPctErr * 100).toFixed(1)}%`),
        esc(row.hitBands.map((band) => `${band[0]}-${band[1] > 99999 ? 'inf' : band[1]}`).join(' ')),
        esc(row.keyword),
      ].join(','),
    )
  }
  return `\uFEFF${lines.join('\n')}\n`
}

function printRow(row) {
  const truth = `${Math.round(row.truth.min / 1000)}–${Math.round(row.truth.max / 1000)}K`
  const estimate = row.estimate.openEnded
    ? '60K+'
    : row.estimate.max == null
      ? '—'
      : `${Math.round(row.estimate.min / 1000)}–${Math.round(row.estimate.max / 1000)}K`
  const err = row.midPctErr == null ? '—' : `${(row.midPctErr * 100).toFixed(1)}%`
  const hits = row.hitBands.map((band) => `${band[0] / 1000}-${band[1] >= 999999 ? '∞' : band[1] / 1000}`).join(',')
  console.log(
    `  ${row.company.slice(0, 26).padEnd(26)} ${row.title.slice(0, 30).padEnd(30)} 真值 ${truth.padEnd(9)} 反推 ${estimate.padEnd(9)} 误差 ${err.padEnd(8)} 命中 ${row.hitBands.length} 档 [${hits}]`,
  )
}

async function main() {
  console.log('== 薪酬反查校准 ==')
  console.log(`关键词 ${KEYWORDS.length} 个 · 每词 ${PAGES} 页 · 上限 ${LIMIT} 条 · 间隔 ${GAP_MS}ms`)

  console.log('\n[1/4] 收集公开薪资岗位…')
  const sample = await collectSample()
  console.log(`  共 ${sample.length} 条（已按公司+标题+薪资去重）`)
  if (sample.length === 0) {
    console.log('  没有样本，退出')
    return
  }

  console.log('\n[2/4] 检查岗位是否仍在架、公司是否可探…')
  const entries = await inspectCompanies(sample)
  const skipped = entries.filter((entry) => entry.skip)
  const probeableJobs = entries.flatMap((entry) => entry.alive ?? [])
  console.log(`  公司 ${entries.length} 家：可探 ${entries.length - skipped.length} 家，跳过 ${skipped.length} 家`)
  for (const entry of skipped) console.log(`    - ${entry.keyword}: ${entry.skip}（${entry.group.length} 条）`)

  console.log('\n[3/4] 逐档盲探（每次 11 档，和点开岗位时一致）…')
  const rows = []
  let done = 0
  for (const entry of entries) {
    if (entry.skip || !entry.alive || entry.alive.length === 0) continue
    const probe = await probeCompany(entry)
    for (const job of entry.alive) {
      const hitBands = probe.hits.get(job.id) ?? []
      const estimate = reconstruct(hitBands)
      const truthOver60 = job.truth.mid >= 60000
      const midPctErr = estimate && !estimate.openEnded && estimate.mid != null
        ? (estimate.mid - job.truth.mid) / job.truth.mid
        : null
      rows.push({
        id: job.id,
        keyword: job.keyword,
        company: job.company,
        title: job.title,
        salaryLabel: job.salaryLabel,
        truth: job.truth,
        truthOver60,
        hitBands: hitBands.map((band) => [band[0], band[1]]),
        estimate: estimate ?? { min: null, max: null, mid: null, openEnded: false },
        midPctErr,
        midIn: Boolean(estimate && !estimate.openEnded && estimate.min <= job.truth.mid && job.truth.mid <= estimate.max),
        overlap: Boolean(estimate && !estimate.openEnded && estimate.min <= job.truth.max && estimate.max >= job.truth.min),
        truncated: probe.truncated,
      })
    }
    done += entry.alive.length
    if (done === probeableJobs.length || done % 10 < 2) {
      console.log(`  已探 ${done}/${probeableJobs.length} 条 · 请求 ${requestCount} 次`)
    }
  }

  // 探不到的岗位（0 档命中）也保留在 rows 里，是分母的一部分；这里单独列出来方便解释。
  const noHit = rows.filter((row) => row.hitBands.length === 0)
  const goneJobs = entries.filter((entry) => !entry.skip).flatMap((entry) => entry.gone ?? [])
  const skippedJobs = skipped.reduce((sum, entry) => sum + entry.group.length, 0)

  const summary = summarize(rows)
  summary.probed = rows.length - noHit.length
  summary.probeable = rows.length
  summary.coverage = rows.length === 0 ? 0 : summary.probed / rows.length
  const result = {
    generatedAt: new Date().toISOString(),
    keywords: KEYWORDS,
    config: { pages: PAGES, limit: LIMIT, gapMs: GAP_MS, probePageLimit: PROBE_PAGE_LIMIT, maxCompanyAds: MAX_COMPANY_ADS },
    requests: requestCount,
    errors: errorCount,
    sample: {
      collected: sample.length,
      probeable: rows.length,
      skippedCompanies: skippedJobs,
      goneJobs: goneJobs.length,
    },
    summary,
    noHit: noHit.map((row) => ({ id: row.id, company: row.company, title: row.title, salaryLabel: row.salaryLabel, truncated: row.truncated })),
    goneJobs: goneJobs.map((job) => ({ id: job.id, company: job.company, title: job.title, salaryLabel: job.salaryLabel })),
    skippedCompanies: skipped.map((entry) => ({ company: entry.keyword, reason: entry.skip, jobs: entry.group.map((job) => job.id) })),
    rows,
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(result, null, 2), 'utf8')
  const csvPath = /\.json$/i.test(OUT) ? OUT.replace(/\.json$/i, '.csv') : `${OUT}.csv`
  await writeFile(csvPath, toCsv(rows), 'utf8')

  console.log('\n[4/4] 结果')
  console.log(`  样本 ${summary.collected} 条 · 可探 ${summary.probeable} 条 · 探到 ${summary.probed} 条（${(summary.coverage * 100).toFixed(0)}%）· 参与打分 ${summary.scored} 条`)
  console.log(`  中点误差：中位数 ${(summary.medianAbsPctErr * 100).toFixed(1)}% · P90 ${(summary.p90AbsPctErr * 100).toFixed(1)}%`)
  console.log(`  ±10% 内 ${(summary.within10 * 100).toFixed(0)}% · ±15% 内 ${(summary.within15 * 100).toFixed(0)}% · ±20% 内 ${(summary.within20 * 100).toFixed(0)}%`)
  console.log(`  真值中点落在反推区间：${(summary.midInRate * 100).toFixed(0)}% · 区间有交集：${(summary.overlapRate * 100).toFixed(0)}%`)
  console.log(`  区间宽度（相对真值）：×${summary.medianWidthRatio?.toFixed(2) ?? '—'}`)
  console.log('\n  按真值薪资段：')
  for (const bucket of summary.byBucket) {
    console.log(`    ${bucket.bucket.padEnd(9)} n=${String(bucket.n).padEnd(3)} 中点落在区间 ${bucket.midIn == null ? '—' : (bucket.midIn * 100).toFixed(0) + '%'} · 误差中位数 ${bucket.medianAbsPctErr == null ? '—' : (bucket.medianAbsPctErr * 100).toFixed(1) + '%'}`)
  }
  console.log('\n  明细（前 20 条）：')
  for (const row of rows.slice(0, 20)) printRow(row)
  console.log(`\n  已写入 ${OUT}`)
}

main().catch((error) => {
  console.error('[FATAL]', error?.stack ?? error)
  process.exitCode = 1
})
