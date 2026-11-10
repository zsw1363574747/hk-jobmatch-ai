/**
 * 关键词薪酬参考（报表）。
 *
 * 思路：不去逐条猜某个岗位的薪资，而是问平台「这个关键词下，各薪资档各有多少条」——
 * 每个档一次请求（totalCount），11 次就能画出一条分布，再取中位数/四分位。
 * 便宜（≈11 次请求/关键词）、且覆盖的是**整个关键词市场**（含未展示薪资的岗位）。
 *
 * 实测校准（2026-11-06）：
 *   data analyst   分布中位数 ≈ 32.5k，明码样本中位数 31.5k
 *   accountant     分布中位数 ≈ 32.5k，明码样本中位数 35.0k
 * 误差 1–2k，做「参考」够了；不拿它冒充某条岗位的确切薪资。
 *
 * 已知偏差：平台的档位筛选会向外多算几档（11 档的合计约为岗位数的 3–4 倍），所以分布被轻微抹平；
 * 中位数稳，尾部分位（P10/P90）不要用。
 *
 * 口径补充（2026-11-10）：多词关键词统一加引号做短语匹配（quoteKeyword）。
 * 不加引号时平台按分词 AND 命中，`product manager` 会算进所有含 product+manager 的岗位
 * （实测 2709 条），加引号后是 187 条，中位数不变但样本含义完全不同。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEARCH_BASE, SITE_KEY, SOURCE_SYSTEM } from '../../constants.js'
import { fetchText } from '../../net.js'
import { PROBE_BANDS, PROBE_TOP_BAND } from './probe.js'
import { parseSalaryLabel } from '../../domain/salary.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const GRAPH_PATH = join(HERE, '..', '..', '..', 'data', 'role-graph.json')
const DEFAULT_GAP_MS = 260

/** 多词关键词加引号，避免被拆成 OR（`product manager` 会匹配到所有 manager）。 */
export function quoteKeyword(keyword) {
  const value = String(keyword ?? '').trim()
  if (value === '' || /^".*"$/.test(value) || !/\s/.test(value)) return value
  return `"${value}"`
}

/** 该关键词下总共有多少条岗位（不加薪资筛选）。 */
export async function countJobs(keyword, options = {}) {
  try {
    const url = new URL(SEARCH_BASE)
    url.searchParams.set('siteKey', SITE_KEY)
    url.searchParams.set('sourcesystem', SOURCE_SYSTEM)
    url.searchParams.set('keywords', quoteKeyword(keyword))
    url.searchParams.set('page', '1')
    url.searchParams.set('pageSize', '30')
    const text = await fetchText(url.toString(), {
      fetchImpl: options.fetchImpl,
      userAgent: options.userAgent,
      headers: { accept: 'application/json', referer: 'https://hk.jobsdb.com/' },
    })
    return Number(JSON.parse(text)?.totalCount) || 0
  } catch {
    return 0
  }
}

let graphCache = null

export function loadRoleGraph() {
  if (graphCache) return graphCache
  try {
    const raw = JSON.parse(readFileSync(GRAPH_PATH, 'utf8'))
    graphCache = raw.graph ?? {}
  } catch {
    graphCache = {}
  }
  return graphCache
}

/** 关键词 → 相关岗位；没配置就返回空数组（不硬凑）。 */
export function relatedRoles(keyword) {
  const graph = loadRoleGraph()
  const key = String(keyword ?? '').trim().toLowerCase()
  if (key === '') return []
  if (Array.isArray(graph[key])) return [...graph[key]]
  // 英文单复数 / 空格差异
  for (const [node, list] of Object.entries(graph)) {
    if (node.replace(/\s+/g, ' ') === key.replace(/\s+/g, ' ')) return [...list]
  }
  return []
}

function buildCountUrl(keyword, band) {
  const url = new URL(SEARCH_BASE)
  url.searchParams.set('siteKey', SITE_KEY)
  url.searchParams.set('sourcesystem', SOURCE_SYSTEM)
  url.searchParams.set('keywords', quoteKeyword(keyword))
  url.searchParams.set('page', '1')
  url.searchParams.set('pageSize', '30')
  url.searchParams.set('salarytype', 'monthly')
  url.searchParams.set('salaryrange', `${band[0]}-${band[1]}`)
  return url.toString()
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一次关键词 → 各档的岗位数。 */
export async function bandCounts(keyword, options = {}) {
  const gapMs = Number.isFinite(options.gapMs) ? options.gapMs : DEFAULT_GAP_MS
  const sleep = options.sleep ?? defaultSleep
  const bands = [...PROBE_BANDS, PROBE_TOP_BAND]
  const rows = []
  let requests = 0
  for (let index = 0; index < bands.length; index += 1) {
    if (index > 0) await sleep(gapMs)
    const band = bands[index]
    try {
      const text = await fetchText(buildCountUrl(keyword, band), {
        fetchImpl: options.fetchImpl,
        userAgent: options.userAgent,
        headers: { accept: 'application/json, text/plain, */*', referer: 'https://hk.jobsdb.com/' },
      })
      const json = JSON.parse(text)
      requests += 1
      rows.push({ band, count: Number(json?.totalCount) || 0 })
    } catch {
      rows.push({ band, count: 0, error: true })
    }
  }
  return { rows, requests }
}

/** 档位计数 → 中位数与四分位（档中心加权）。 */
export function estimateFromHistogram(rows) {
  const points = rows
    .filter((row) => row.count > 0)
    .map((row) => ({
      // 顶档按 70k 封顶，避免 999999 把中心拉飞
      center: Math.round((row.band[0] + Math.min(row.band[1], 70000)) / 2),
      count: row.count,
    }))
    .sort((left, right) => left.center - right.center)
  const total = points.reduce((sum, point) => sum + point.count, 0)
  if (total < 20) return { total, median: null, p25: null, p75: null }

  const quantile = (q) => {
    const target = total * q
    let acc = 0
    for (const point of points) {
      acc += point.count
      if (acc >= target) return point.center
    }
    return points[points.length - 1].center
  }

  return { total, median: quantile(0.5), p25: quantile(0.25), p75: quantile(0.75) }
}

/** 顺手取一页明码薪资做交叉核对（可选）。 */
async function explicitSample(keyword, options = {}) {
  try {
    const url = new URL(SEARCH_BASE)
    url.searchParams.set('siteKey', SITE_KEY)
    url.searchParams.set('sourcesystem', SOURCE_SYSTEM)
    url.searchParams.set('keywords', quoteKeyword(keyword))
    url.searchParams.set('page', '1')
    url.searchParams.set('pageSize', '30')
    const text = await fetchText(url.toString(), {
      fetchImpl: options.fetchImpl,
      userAgent: options.userAgent,
      headers: { accept: 'application/json', referer: 'https://hk.jobsdb.com/' },
    })
    const json = JSON.parse(text)
    const values = []
    for (const item of json?.data ?? []) {
      const parsed = parseSalaryLabel(item.salaryLabel)
      if (parsed && parsed.period === 'month') values.push(parsed.mid)
    }
    if (values.length === 0) return { n: 0, median: null }
    values.sort((a, b) => a - b)
    return { n: values.length, median: values[Math.floor(values.length / 2)] }
  } catch {
    return { n: 0, median: null }
  }
}

/**
 * 生成一份「关键词 + 相关岗位」的薪酬参考。
 * @param {{keyword:string, related?:string[], maxRelated?:number, withExplicit?:boolean}} input
 */
export async function salaryReport(input = {}, options = {}) {
  const keyword = String(input.keyword ?? '').trim()
  if (keyword === '') return { ok: false, code: 'E_NO_KEYWORD' }

  const maxRelated = Math.max(0, Math.min(6, Number(input.maxRelated ?? 5)))
  const list = Array.isArray(input.related) && input.related.length > 0
    ? input.related.slice(0, maxRelated)
    : relatedRoles(keyword).slice(0, maxRelated)

  const started = Date.now()
  const rows = []
  const mainBands = await bandCounts(keyword, options)
  const main = estimateFromHistogram(mainBands.rows)
  const mainJobs = await countJobs(keyword, options)
  const mainExplicit = input.withExplicit === false ? null : await explicitSample(keyword, options)
  rows.push({ keyword, role: 'main', ...main, jobs: mainJobs, requests: mainBands.requests, explicit: mainExplicit })

  for (const role of list) {
    const counts = await bandCounts(role, options)
    const est = estimateFromHistogram(counts.rows)
    const jobs = await countJobs(role, options)
    rows.push({ keyword: role, role: 'related', ...est, jobs, requests: counts.requests })
  }

  return {
    ok: true,
    keyword,
    generatedAt: new Date().toISOString(),
    ms: Date.now() - started,
    rows,
    hasRelated: list.length > 0,
    note: list.length === 0 ? '这个关键词还没配相关岗位；可以在 bundle/data/role-graph.json 里加' : '',
  }
}
