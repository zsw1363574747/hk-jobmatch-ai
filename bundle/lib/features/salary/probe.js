/**
 * 平台筛选探针（P1）：用 JobsDB 自己的「薪资区间」筛选去反推隐藏薪资。
 *
 * 原理（2026-11-06 实测）：
 *   - 雇主填了薪资但可以选「不展示」，此时 salaryLabel 是空的；
 *   - 但搜索接口的 salaryrange 筛选会按那份隐藏薪资过滤
 *     （必须同时带 salarytype=monthly，否则退化成默认集合）；
 *   - 拿公司的名字当关键词，逐档查一次，看这条岗位在哪些档里出现，
 *     命中集合 ≈ [min − 5k, max + 5k]，减掉那 5k 就是薪资区间。
 *
 * 实测两个已知答案的岗位：
 *   28–35k  → 命中 20/25/30/35/40 五档 → 反推 25–40，中点误差 1k
 *   45–55k  → 命中 40/45/50/55 四档   → 反推 45–55，完全吻合
 *
 * 只在用户点开某条岗位时跑（成本换精度），结果缓存 7 天。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SEARCH_BASE, SITE_KEY, SOURCE_SYSTEM } from '../../constants.js'
import { fetchText } from '../../net.js'

const SMEAR = 5000 // 命中区间向外多出的那一档
const TOP = 60000 // 60k 以上只报「60k+」

export const PROBE_BANDS = Object.freeze([
  [10000, 15000],
  [15000, 20000],
  [20000, 25000],
  [25000, 30000],
  [30000, 35000],
  [35000, 40000],
  [40000, 45000],
  [45000, 50000],
  [50000, 55000],
  [55000, 60000],
])

export const PROBE_TOP_BAND = Object.freeze([60000, 999999])

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function buildUrl(keyword, band, page) {
  const url = new URL(SEARCH_BASE)
  url.searchParams.set('siteKey', SITE_KEY)
  url.searchParams.set('sourcesystem', SOURCE_SYSTEM)
  url.searchParams.set('keywords', keyword)
  url.searchParams.set('page', String(page))
  url.searchParams.set('pageSize', '30')
  url.searchParams.set('salarytype', 'monthly')
  url.searchParams.set('salaryrange', `${band[0]}-${band[1]}`)
  return url.toString()
}

function cachePath(dataDir) {
  return join(dataDir ?? '.', 'salary-cache.json')
}

async function readCache(dataDir) {
  try {
    return JSON.parse(await readFile(cachePath(dataDir), 'utf8'))
  } catch {
    return {}
  }
}

async function writeCache(dataDir, cache) {
  try {
    await mkdir(dirname(cachePath(dataDir)), { recursive: true })
    await writeFile(cachePath(dataDir), JSON.stringify(cache, null, 0), 'utf8')
  } catch {
    // 缓存写不进去不影响主流程
  }
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 关键词：公司名最稳；公司名叫 Confidential / N/A 时退回标题。 */
function probeKeyword(job) {
  const company = String(job?.company ?? '').trim()
  const bad = /^(confidential|private|n\/?a|na|unknown|client|our client|某公司)$/i
  if (company && company.length >= 2 && !bad.test(company)) return company
  return String(job?.title ?? '').trim()
}

/**
 * 看这条岗位在某个区间里是否出现。结果可能不在第一页，最多翻 3 页。
 */
async function appearsInBand(job, keyword, band, options) {
  const fetchImpl = options.fetchImpl
  const gapMs = Number.isFinite(options.gapMs) ? options.gapMs : 350
  const id = String(job.nativeId ?? job.id ?? '')
  let probes = 0
  for (let page = 1; page <= 3; page += 1) {
    if (probes > 0) await (options.sleep ?? defaultSleep)(gapMs)
    probes += 1
    try {
      const text = await fetchText(buildUrl(keyword, band, page), {
        fetchImpl,
        userAgent: options.userAgent,
        headers: { accept: 'application/json, text/plain, */*', referer: 'https://hk.jobsdb.com/' },
      })
      const json = JSON.parse(text)
      const items = Array.isArray(json?.data) ? json.data : []
      if (items.some((item) => String(item.id) === id)) return { hit: true, probes }
      const total = Number(json?.totalCount) || 0
      if (items.length === 0 || page * 30 >= total) return { hit: false, probes }
    } catch (error) {
      return { hit: false, probes, error: error?.code ?? 'E_NETWORK' }
    }
  }
  return { hit: false, probes }
}

/** 命中档位 → 薪资区间。 */
export function reconstruct(hitBands) {
  if (!hitBands || hitBands.length === 0) return null
  const lows = hitBands.map((band) => band[0])
  const highs = hitBands.map((band) => band[1])
  const low = Math.min(...lows)
  const high = Math.max(...highs)
  const openEnded = high >= 999999 || low >= TOP

  if (openEnded) {
    return { min: TOP, max: null, mid: null, openEnded: true, low, high: null }
  }

  const min = Math.max(5000, low + SMEAR)
  const max = Math.max(min, high - SMEAR)
  return { min, max, mid: Math.round((min + max) / 2), openEnded: false, low, high }
}

/**
 * 探一条岗位的隐藏薪资（带缓存）。
 * @returns {{ok:boolean, salary?:object, bands?:number[][], probes?:number, ms?:number, cached?:boolean, reason?:string}}
 */
export async function probeSalary(job, options = {}) {
  const started = Date.now()
  const id = String(job?.nativeId ?? job?.id ?? '')
  if (id === '') return { ok: false, reason: 'E_BAD_PARAM' }
  if (String(job?.source ?? 'jobsdb') !== 'jobsdb') return { ok: false, reason: 'E_UNSUPPORTED_SOURCE' }

  const cache = await readCache(options.dataDir)
  const key = `${probeKeyword(job)}::${id}`
  const cached = cache[key]
  if (cached && Date.now() - (cached.at ?? 0) < CACHE_TTL_MS && cached.salary) {
    return { ok: true, cached: true, salary: cached.salary, bands: cached.bands ?? [], probes: 0, ms: Date.now() - started }
  }

  const keyword = probeKeyword(job)
  if (keyword === '') return { ok: false, reason: 'E_NO_KEYWORD' }

  const hitBands = []
  let probes = 0
  const bands = [...PROBE_BANDS, PROBE_TOP_BAND]
  for (const band of bands) {
    const result = await appearsInBand(job, keyword, band, { ...options })
    probes += result.probes
    if (result.hit) hitBands.push(band)
  }

  if (hitBands.length === 0) {
    return { ok: false, reason: 'E_NO_BAND_HIT', probes, ms: Date.now() - started }
  }

  const range = reconstruct(hitBands)
  const now = new Date().toISOString()
  const salary = {
    currency: 'HKD',
    period: 'month',
    min: range.min,
    max: range.max,
    mid: range.mid,
    openEnded: Boolean(range.openEnded),
    label: '',
    bonus: '',
    kind: 'probed',
    confidence: 'B-',
    source: 'platform-filter',
    evidence: {
      platform: 'jobsdb',
      keyword,
      bands: hitBands.map((band) => `${band[0]}-${band[1]}`),
      probes,
      at: now,
    },
  }

  cache[key] = { at: Date.now(), salary, bands: salary.evidence.bands }
  await writeCache(options.dataDir, cache)

  return { ok: true, cached: false, salary, bands: salary.evidence.bands, probes, ms: Date.now() - started }
}

/**
 * 把详情页读到的 Salary match 记进缓存，下次点开（缓存命中）不用再渲染详情页。
 * 只存 true/false；找不到缓存条目就安静跳过。
 */
export async function rememberSalaryBadge(job, match, dataDir) {
  const cache = await readCache(dataDir)
  const key = `${probeKeyword(job)}::${String(job?.nativeId ?? job?.id ?? '')}`
  const entry = cache[key]
  if (!entry?.salary) return
  entry.salary.expectedSalaryMatch = match === true
  await writeCache(dataDir, cache)
}
