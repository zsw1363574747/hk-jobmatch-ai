/**
 * 来源注册表：一个关键词 → 多个平台 → 一份去重后的岗位清单。
 *
 * 每个来源实现同一份契约：
 *   descriptor  站点信息（id / label / kind / needsBrowser / note）
 *   search()    { source, jobs[], warnings[], ms, blocked? }
 *   fetchDetail(job) { ok, detail, warnings }
 *
 * 分两层：
 *   CATALOG             所有写好的适配器（停用的也在），历史 run 的详情还能靠它打开；
 *   ENABLED_SOURCE_IDS  真正参与搜索的站点，界面只列这些。
 * 加新站：写模块 → 放进 CATALOG → 把 id 加进 ENABLED_SOURCE_IDS。
 * 停用某站：只从 ENABLED_SOURCE_IDS 删掉；模块、sites.js 配置、浏览器驱动都原样留着。
 */
import * as jobsdb from './jobsdb.js'
import { ctgoodjobs } from './sites.js'
import { browserStatus } from './browser.js'
import { PAGE_SIZE } from '../constants.js'

/** 所有已实现的适配器；顺序就是来源优先级。 */
const CATALOG = [jobsdb, ctgoodjobs]

/**
 * 当前启用的来源。
 * 2026-11 起 CTgoodjobs 暂停：AWS WAF 常要人工验证、浏览器来源又只能串行，太慢。
 * 代码没删——把它加回这个数组就恢复，历史 run 里的 CTgoodjobs 详情也一直能打开。
 */
export const ENABLED_SOURCE_IDS = Object.freeze(['jobsdb'])

const REGISTRY = new Map(CATALOG.map((module) => [module.descriptor.id, module]))
const ENABLED = new Set(ENABLED_SOURCE_IDS)

/** 默认开哪些：跟启用列表一致；现在只有 JobsDB（HTTP，主力）。 */
export const DEFAULT_SOURCES = Object.freeze([...ENABLED_SOURCE_IDS])

export function isEnabled(id) {
  return ENABLED.has(String(id))
}

/** 界面用：只列启用的来源。 */
export function listSources() {
  const browser = browserStatus()
  return [...REGISTRY.values()]
    .filter((module) => ENABLED.has(module.descriptor.id))
    .map((module) => ({
      ...module.descriptor,
      available: module.descriptor.needsBrowser ? browser.ok : true,
      ...(module.descriptor.needsBrowser ? { hint: browser.ok ? '' : browser.hint } : {}),
    }))
}

export function hasSource(id) {
  return REGISTRY.has(String(id))
}

export function getSource(id) {
  const module = REGISTRY.get(String(id))
  if (!module) {
    const error = new Error(`unknown source: ${id}`)
    error.code = 'E_BAD_PARAM'
    throw error
  }
  return module
}

export function normalizeSourceIds(value) {
  const raw = Array.isArray(value) ? value : value == null ? DEFAULT_SOURCES : [value]
  const ids = []
  for (const item of raw) {
    const id = String(item ?? '').trim().toLowerCase()
    if (id === '' || ids.includes(id)) continue
    // 停用的来源不接受搜索请求（但历史详情仍可按 source 打开）。
    if (!ENABLED.has(id)) continue
    ids.push(id)
  }
  return ids.length > 0 ? ids : [...DEFAULT_SOURCES]
}

/** 跨站去重：同一家公司 + 同一个标题算同一条（先到先得，按来源优先级）。 */
export function dedupeJobs(jobs) {
  const seenKey = new Set()
  const seenFingerprint = new Set()
  const kept = []
  for (const job of jobs) {
    if (!job || !job.title) continue
    if (job.key && seenKey.has(job.key)) continue
    const fingerprint = `${String(job.title).toLowerCase().replace(/\s+/g, ' ').trim()}@@${String(job.company ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`
    if (job.company && seenFingerprint.has(fingerprint)) continue
    if (job.key) seenKey.add(job.key)
    if (job.company) seenFingerprint.add(fingerprint)
    kept.push(job)
  }
  return kept
}

/**
 * 并行搜多个站，单站失败不影响整体。
 * 浏览器来源串行执行（共用同一个 profile，并发开会打架）。
 */
export async function searchAll(input = {}, options = {}) {
  const sourceIds = normalizeSourceIds(input.sources)
  const keywords = input.keywords
  // 抓几页就留几页的条数：以前这里固定留 30 条，翻页等于白抓。
  const pages = Math.max(1, Math.min(10, Number(input.maxPages) || 1))
  const perSource = Math.max(5, Math.min(200, Number(input.perSource) || pages * PAGE_SIZE))
  // 浏览器来源一次会话里顺手把前几条详情也抓了（政府站详情必须同源 cookie），
  // HTTP 来源不需要，详情留到 /api/jobs 再按 GraphQL 取。
  const detailLimit = Math.max(0, Math.min(20, Number(input.detailLimit ?? 6)))
  const gapMs = Number.isFinite(options.gapMs) ? options.gapMs : 1200
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  const results = []
  const httpIds = sourceIds.filter((id) => !REGISTRY.get(id).descriptor.needsBrowser)
  const browserIds = sourceIds.filter((id) => REGISTRY.get(id).descriptor.needsBrowser)

  const runOne = async (id) => {
    const module = REGISTRY.get(id)
    const started = Date.now()
    try {
      const result = await module.search({
        keywords,
        pages,
        detailLimit,
        gapMs,
        sleep,
        fetchImpl: options.fetchImpl,
        userAgent: options.userAgent,
        profile: options.profile,
        executable: options.executable,
        headless: options.headless,
      })
      const jobs = (result.jobs ?? []).slice(0, perSource)
      return {
        id,
        label: module.descriptor.label,
        ok: jobs.length > 0,
        count: jobs.length,
        totalCount: result.totalCount ?? jobs.length,
        blocked: Boolean(result.blocked),
        ms: result.ms ?? Date.now() - started,
        warnings: result.warnings ?? [],
        jobs,
      }
    } catch (error) {
      return {
        id,
        label: module.descriptor.label,
        ok: false,
        count: 0,
        totalCount: 0,
        blocked: false,
        ms: Date.now() - started,
        warnings: [{ code: error?.code ?? 'E_INTERNAL', note: String(error?.message ?? error).slice(0, 200) }],
        jobs: [],
      }
    }
  }

  const httpResults = await Promise.all(httpIds.map(runOne))
  results.push(...httpResults)
  for (const id of browserIds) {
    results.push(await runOne(id))
  }

  // 按来源优先级排（jobsdb 在前），同站内保持原有顺序
  const priority = sourceIds
  const ordered = results.flatMap((entry) => entry.jobs.map((job) => ({ job, rank: priority.indexOf(entry.id) })))
  ordered.sort((left, right) => left.rank - right.rank || Date.parse(right.job.listedAt ?? '') - Date.parse(left.job.listedAt ?? ''))
  const jobs = dedupeJobs(ordered.map((entry) => entry.job))

  return {
    jobs,
    stats: results.map(({ jobs: _jobs, ...rest }) => rest),
    total: jobs.length,
    fetched: results.reduce((sum, entry) => sum + entry.count, 0),
  }
}

/** 详情分发：按 job.source 找对应适配器。 */
export async function fetchDetail(job, options = {}) {
  const id = String(job?.source ?? '')
  const module = REGISTRY.get(id)
  if (!module) return { ok: false, code: 'E_BAD_PARAM', detail: null, warnings: [] }
  return module.fetchDetail(job, options)
}

/** 逐站自检：不抓岗位，只回答「启用的来源现在通不通」。 */
export async function probeSources(options = {}) {
  const rows = []
  for (const [id, module] of REGISTRY) {
    if (!ENABLED.has(id)) continue
    if (module.probe) {
      rows.push({ id, label: module.descriptor.label, ...(await module.probe(options)) })
      continue
    }
    const started = Date.now()
    try {
      const result = await module.search({ keywords: 'data analyst', detailLimit: 0, ...options })
      const first = result.warnings?.[0]
      rows.push({
        id,
        label: module.descriptor.label,
        ok: (result.jobs ?? []).length > 0,
        count: result.jobs?.length ?? 0,
        blocked: Boolean(result.blocked),
        ms: Date.now() - started,
        note: first?.note ?? '',
      })
    } catch (error) {
      rows.push({ id, label: module.descriptor.label, ok: false, ms: Date.now() - started, note: String(error?.message ?? error).slice(0, 160) })
    }
  }
  return rows
}
