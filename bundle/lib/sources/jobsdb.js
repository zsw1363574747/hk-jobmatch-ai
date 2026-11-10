/**
 * JobsDB 香港站适配器（HTTP，无浏览器、无登录）。
 *
 * 两条腿：
 *   1. 列表 —— 公开搜索接口 /api/jobsearch/v5/search（每页 30 条，page ≤ 1000）；
 *   2. 正文 —— GraphQL jobDetails，`content` 就是 JD 全文 HTML。
 *
 * 第 2 条是本项目以前缺的那块：/job/{id} 详情页被 Cloudflare 挡（403），
 * 但 /graphql 是站点前端自己在用的接口，返回 200 且带全文，所以不用再退到 teaser。
 */
import { fetchText } from '../net.js'
import { htmlToText } from '../text.js'
import { parseSeekRedux } from '../jobsdb.js'
import { PAGE_SIZE, SEARCH_BASE, SITE_KEY, SOURCE_SYSTEM } from '../constants.js'
import { fail } from '../errors.js'

export const SOURCE_ID = 'jobsdb'
export const SOURCE_LABEL = 'JobsDB'

const GRAPHQL_URL = 'https://hk.jobsdb.com/graphql'
const JOB_URL = 'https://hk.jobsdb.com/job/{id}'
const FEATURES_HEADER = 'application/features.seek.all+json'

const DETAIL_QUERY = `query JobDetail($id: ID!) {
  jobDetails(id: $id) {
    job {
      id
      title
      abstract
      content
      isExpired
      advertiser { name }
      salary { label }
      location { label }
      classifications { label(languageCode: "en") }
      listedAt { dateTimeUtc }
    }
  }
}`

function toArray(value) {
  return Array.isArray(value) ? value : []
}

export function buildSearchUrl(query = {}) {
  const raw = Array.isArray(query.keywords) ? query.keywords : [query.keywords]
  const keywords = raw
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .join(' ')
  const url = new URL(SEARCH_BASE)
  url.searchParams.set('siteKey', SITE_KEY)
  url.searchParams.set('sourcesystem', SOURCE_SYSTEM)
  url.searchParams.set('keywords', keywords)
  url.searchParams.set('page', String(query.page ?? 1))
  url.searchParams.set('pageSize', String(query.pageSize ?? PAGE_SIZE))
  return url.toString()
}

export function jobUrl(id) {
  return JOB_URL.replace('{id}', encodeURIComponent(String(id)))
}

/** v5 搜索 JSON → 统一 Job 形状。 */
export function normalizeSearch(json) {
  const items = json && Array.isArray(json.data) ? json.data : []
  const seen = new Set()
  const jobs = []
  for (const item of items) {
    const id = item && item.id != null ? String(item.id) : ''
    const title = item && typeof item.title === 'string' ? item.title.trim() : ''
    if (id === '' || title === '' || seen.has(id)) continue
    seen.add(id)
    jobs.push({
      key: `${SOURCE_ID}:${id}`,
      source: SOURCE_ID,
      sourceLabel: SOURCE_LABEL,
      nativeId: id,
      id,
      title,
      company: item.companyName ?? item.advertiser?.description ?? '',
      salaryLabel: typeof item.salaryLabel === 'string' ? item.salaryLabel : '',
      locations: toArray(item.locations).map((entry) => entry?.label).filter(Boolean),
      workTypes: toArray(item.workTypes).filter((entry) => typeof entry === 'string'),
      classifications: toArray(item.classifications)
        .map((entry) => entry?.subclassification?.description ?? entry?.classification?.description)
        .filter(Boolean),
      listedAt: typeof item.listingDate === 'string' ? item.listingDate : '',
      teaser: typeof item.teaser === 'string' ? item.teaser : '',
      url: jobUrl(id),
      detailRef: { id },
    })
  }
  return { jobs, totalCount: Number.isFinite(json?.totalCount) ? json.totalCount : 0 }
}

/** 搜索（可多页）。单页失败不炸整轮，交给上层记 warnings。 */
export async function search(options = {}) {
  const keywords = options.keywords
  const pages = Math.max(1, Math.min(10, Number(options.pages) || 1))
  const gapMs = Number.isFinite(options.gapMs) ? options.gapMs : 1200
  const fetchImpl = options.fetchImpl
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  const merged = new Map()
  let totalCount = 0
  let fetched = 0
  const warnings = []

  for (let page = 1; page <= pages; page += 1) {
    if (page > 1) await sleep(gapMs)
    try {
      const text = await fetchText(buildSearchUrl({ keywords, page, pageSize: PAGE_SIZE }), {
        fetchImpl,
        userAgent: options.userAgent,
        headers: { accept: 'application/json, text/plain, */*', referer: 'https://hk.jobsdb.com/' },
      })
      const json = JSON.parse(text)
      const result = normalizeSearch(json)
      if (result.totalCount > 0) totalCount = result.totalCount
      fetched += result.jobs.length
      for (const job of result.jobs) merged.set(job.key, job)
    } catch (error) {
      warnings.push({ code: error?.code ?? 'E_NETWORK', note: `jobsdb page ${page}` })
      break
    }
  }

  return { source: SOURCE_ID, jobs: [...merged.values()], totalCount, fetched, warnings }
}

/** 把 GraphQL 返回值转成统一 detail（纯函数，离线自检也用它）。 */
export function parseDetail(payload, id = '') {
  const node = payload?.data?.jobDetails?.job
  if (!node) {
    const code = payload?.errors ? 'E_PARSE_FAILED' : 'E_JOB_GONE'
    return { ok: false, code, detail: null, warnings: [{ code, note: 'jobsdb graphql empty' }] }
  }

  const contentHtml = typeof node.content === 'string' ? node.content : ''
  const contentText = htmlToText(contentHtml)
  if (contentText.length === 0) {
    return { ok: false, code: 'E_PARSE_FAILED', detail: null, warnings: [{ code: 'E_PARSE_FAILED', note: 'jobsdb empty content' }] }
  }

  return {
    ok: true,
    detail: {
      id: String(node.id ?? id),
      title: typeof node.title === 'string' ? node.title : '',
      company: node.advertiser?.name ?? '',
      salary: node.salary?.label ?? '',
      location: node.location?.label ?? '',
      classifications: toArray(node.classifications).map((entry) => entry?.label).filter(Boolean),
      listedAt: node.listedAt?.dateTimeUtc ?? '',
      isExpired: node.isExpired === true,
      contentHtml,
      contentText,
      contentChars: contentText.length,
      companyProfile: null,
      lite: false,
      source: 'graphql',
    },
    warnings: [],
  }
}

/** GraphQL 的 Advertiser 只有 id/name；公司档案只在岗位页内嵌的 SEEK_REDUX 里。 */
const JOB_PAGE_URL = 'https://hk.jobsdb.com/job/{id}'

/**
 * 顺带取公司档案（行业 / 规模 / 官网 / 简介 / logo）。
 * 用人单位没填档案时页面里就是 null，如实返回 null，不编造；
 * 页面被 Cloudflare 拦、超时或解析失败也安静返回 null，不影响 JD 正文。
 */
async function fetchCompanyProfile(id, options = {}) {
  try {
    const html = await fetchText(JOB_PAGE_URL.replace('{id}', id), {
      fetchImpl: options.fetchImpl,
      userAgent: options.userAgent,
      timeoutMs: options.profileTimeoutMs ?? 9000,
      headers: { accept: 'text/html,application/xhtml+xml', referer: 'https://hk.jobsdb.com/' },
    })
    const profile = parseSeekRedux(html)?.companyProfile
    return profile && typeof profile === 'object' ? profile : null
  } catch {
    return null
  }
}

/** GraphQL：拿 JD 全文。 */
export async function fetchDetail(job, options = {}) {
  const id = String(job?.nativeId ?? job?.id ?? '')
  if (id === '') return { ok: false, code: 'E_BAD_PARAM', detail: null, warnings: [] }

  // 正文已经在手：点开时只补公司档案，别再走一遍 GraphQL（这就是「点一下卡一下」的主因）
  const existing = options.existing
  if (existing && existing.contentChars > 0) {
    if (options.withProfile !== false && !existing.companyProfile) {
      const companyProfile = await fetchCompanyProfile(id, options)
      return { ok: true, detail: { ...existing, companyProfile: companyProfile ?? existing.companyProfile ?? null }, warnings: [] }
    }
    return { ok: true, detail: existing, warnings: [] }
  }

  const body = JSON.stringify({ query: DETAIL_QUERY, variables: { id } })
  let payload
  try {
    const text = await fetchText(GRAPHQL_URL, {
      fetchImpl: options.fetchImpl,
      userAgent: options.userAgent,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'https://hk.jobsdb.com',
        referer: job?.url ?? jobUrl(id),
        'x-custom-features': FEATURES_HEADER,
      },
      method: 'POST',
      body,
    })
    payload = JSON.parse(text)
  } catch (error) {
    return { ok: false, code: error?.code ?? 'E_NETWORK', detail: null, warnings: [{ code: error?.code ?? 'E_NETWORK', note: 'jobsdb graphql' }] }
  }

  const parsed = parseDetail(payload, id)
  if (parsed.ok && !parsed.detail.companyProfile && options.withProfile !== false) {
    parsed.detail.companyProfile = job?.companyProfile ?? (await fetchCompanyProfile(id, options))
  }
  return parsed
}

/** 供服务层做「来源自检」：一次轻请求，判断站点通不通。 */
export async function probe(options = {}) {
  const started = Date.now()
  try {
    const result = await search({ keywords: ['data analyst'], pages: 1, ...options })
    return { ok: result.jobs.length > 0, count: result.jobs.length, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: error?.code ?? 'E_NETWORK', ms: Date.now() - started }
  }
}

export const descriptor = Object.freeze({
  id: SOURCE_ID,
  label: SOURCE_LABEL,
  kind: 'http',
  home: 'https://hk.jobsdb.com',
  note: '最大站；列表走公开搜索接口，正文走 GraphQL，不需要登录',
  needsBrowser: false,
})

export { fail }
