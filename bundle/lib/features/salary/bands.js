/**
 * 按「JD 写的工作年限」分档的明码薪资统计。
 *
 * 和 report.js 的平台档位推算不同：
 * - 只统计**JD 里明写了月薪**的岗位（salaryLabel 能解析成数字），Negotiable / 空值一律不算；
 * - 年限取 JD 正文（parseExperience），不靠平台筛选；
 * - 样本是「这个关键词下最近 N 页」的岗位，每条都要抓一次 JD，所以条数有上限。
 *
 * 代价：慢（每条 JD 一次请求）且样本不大；换来的是口径清楚：
 * 每条数据都能指回一个真实岗位的薪资范围和它自己写的年限。
 */
import { getSource } from '../../sources/index.js'
import { parseSalaryLabel } from '../../domain/salary.js'
import { parseExperience } from '../../domain/experience.js'
import { quoteKeyword, bandCounts, estimateFromHistogram, countJobs } from './report.js'

const BUCKETS = Object.freeze([
  { id: '0-2', label: '0–2 年', min: 0, max: 2 },
  { id: '3-4', label: '3–4 年', min: 3, max: 4 },
  { id: '5-7', label: '5–7 年', min: 5, max: 7 },
  { id: '8+', label: '8 年以上', min: 8, max: Infinity },
])

const PAGE_LIMIT = 10
const MAX_JD_DEFAULT = 40
const MAX_JD_LIMIT = 80
const DEFAULT_GAP_MS = 800

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 最近秩分位数，样本少时也不做插值。 */
export function quantile(values, q) {
  const list = [...values].sort((left, right) => left - right)
  if (list.length === 0) return null
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil(q * list.length) - 1))
  return list[index]
}

/** 一组明码月薪 → 中位数 / 四分位。 */
export function summarizeValues(values) {
  if (values.length === 0) return { n: 0, median: null, p25: null, p75: null, min: null, max: null }
  const sorted = [...values].sort((left, right) => left - right)
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

export function bucketOfYears(years) {
  // 注意 Number(null) === 0：没解析出年限的必须挡掉，否则会全被算进 0–2 年。
  if (years === null || years === undefined || years === '') return null
  const value = Number(years)
  if (!Number.isFinite(value)) return null
  return BUCKETS.find((bucket) => value >= bucket.min && value <= bucket.max) ?? null
}

/** 只认「能在 JD 里看到数字」的月薪：Negotiable、面议、年薪都不算。 */
export function explicitMonthly(salaryLabel) {
  const parsed = parseSalaryLabel(salaryLabel)
  if (!parsed || parsed.period !== 'month') return null
  if (!Number.isFinite(parsed.min) || !Number.isFinite(parsed.max)) return null
  if (parsed.min <= 0 || parsed.max < parsed.min) return null
  if (parsed.min < 3000 || parsed.max > 400000) return null
  return parsed
}

/**
 * @param {{keyword:string, pages?:number, maxJd?:number, gapMs?:number}} input
 */
export async function salaryBands(input = {}, options = {}) {
  const keyword = String(input.keyword ?? '').trim()
  if (keyword === '') return { ok: false, code: 'E_NO_KEYWORD', message: '缺 keyword' }

  const pages = Math.max(1, Math.min(PAGE_LIMIT, Number(input.pages) || PAGE_LIMIT))
  const maxJd = Math.max(5, Math.min(MAX_JD_LIMIT, Number(input.maxJd) || MAX_JD_DEFAULT))
  const gapMs = Number.isFinite(options.gapMs) ? options.gapMs : DEFAULT_GAP_MS
  const sleep = options.sleep ?? defaultSleep
  const started = Date.now()

  const source = getSource('jobsdb')
  const found = await source.search({
    keywords: quoteKeyword(keyword),
    pages,
    gapMs,
    sleep,
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
  })
  const jobs = found?.jobs ?? []

  // 关键词会命中 JD 正文，不只是标题：算一下「标题里同时含所有词」的比例，
  // 太低就提示池子里很多只是正文提到它，明码样本可能混进不相关岗位。
  const tokens = keyword.toLowerCase().split(/\s+/).filter(Boolean)
  const titleHit = (title) => {
    const value = String(title ?? '').toLowerCase()
    return tokens.every((token) => value.includes(token))
  }
  const titleHits = jobs.filter((job) => titleHit(job.title)).length

  // 只留「明码月薪」的岗位，再按上限抓 JD。
  const withSalary = []
  for (const job of jobs) {
    const salary = explicitMonthly(job.salaryLabel)
    if (salary) withSalary.push({ job, salary })
  }
  const target = withSalary.slice(0, maxJd)

  const rowsByBucket = new Map(BUCKETS.map((bucket) => [bucket.id, []]))
  const overall = []
  const samples = []
  let fetchedJd = 0
  let yearsKnown = 0
  let failed = 0

  for (let index = 0; index < target.length; index += 1) {
    if (index > 0) await sleep(gapMs)
    const { job, salary } = target[index]
    let detail = null
    try {
      const result = await source.fetchDetail(job, { fetchImpl: options.fetchImpl, withProfile: false })
      detail = result?.detail ?? null
    } catch {
      detail = null
    }
    if (!detail?.contentText) {
      failed += 1
      continue
    }
    fetchedJd += 1
    const experience = parseExperience(detail.contentText)
    const bucket = bucketOfYears(experience.requiredYears)
    if (!bucket) continue
    yearsKnown += 1
    const mid = Math.round((salary.min + salary.max) / 2)
    rowsByBucket.get(bucket.id).push(mid)
    overall.push(mid)
    if (samples.length < 200) {
      samples.push({
        title: job.title,
        company: job.company,
        titleHit: titleHit(job.title),
        years: experience.requiredYears,
        bucket: bucket.label,
        min: salary.min,
        max: salary.max,
        label: job.salaryLabel,
        url: job.url,
      })
    }
  }

  const rows = BUCKETS.map((bucket) => {
    const values = rowsByBucket.get(bucket.id) ?? []
    return { id: bucket.id, label: bucket.label, ...summarizeValues(values) }
  })

  // 推测值：明码样本太少时给一个量级参考。来自平台 11 个薪资档加权（report.js），
  // 只能算整个关键词、拆不到年限上，所以单独作为一列，不混进明码中位数。
  let inferred = null
  try {
    const bands = await bandCounts(keyword, { fetchImpl: options.fetchImpl, gapMs })
    const estimate = estimateFromHistogram(bands.rows ?? [])
    if (estimate.median != null) {
      const jobs = await countJobs(keyword, { fetchImpl: options.fetchImpl })
      inferred = { median: estimate.median, p25: estimate.p25, p75: estimate.p75, jobs, bandTotal: estimate.total }
    }
  } catch {
    inferred = null
  }

  return {
    ok: true,
    keyword,
    pages,
    generatedAt: new Date().toISOString(),
    ms: Date.now() - started,
    scanned: jobs.length,
    titleHits,
    explicit: withSalary.length,
    targeted: target.length,
    fetchedJd,
    yearsKnown,
    used: overall.length,
    failed,
    rows,
    overall: summarizeValues(overall),
    inferred,
    samples,
    note:
      yearsKnown === 0
        ? '这个关键词下拿到明码薪资的 JD 里，没有一条写清工作年限；换关键词或加大页数再试。'
        : '',
  }
}
