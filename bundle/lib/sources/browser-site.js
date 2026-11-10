/**
 * 通用「浏览器来源」工厂。
 *
 * 有些站（CTgoodjobs / LinkedIn / Indeed）不给你纯 HTTP 的活路：
 * 403、405、451、Cloudflare、AWS WAF 的 Human Verification。
 * 它们的共同点是数据由前端渲染，所以统一走 CDP 真浏览器，再按站点配置解析。
 *
 * 解析只做两件事，都尽量不依赖 class 名：
 *   1. JSON-LD（schema.org JobPosting）—— 有就直接用，最稳；
 *   2. 链接锚点 —— 按 URL 特征找岗位卡片，标题取锚文本。
 * 解析不出来就如实返回 0 条 + 原因，不编数据。
 */
import { renderPage, renderPages } from './browser.js'
import { htmlToText } from '../text.js'
import { decodeEntities } from '../text.js'

/** 从 HTML 里抠出 JSON-LD 里的 JobPosting 数组（容忍 @graph 与数组混排）。 */
export function extractJsonLd(html) {
  const blocks = [...String(html ?? '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
  const found = []
  for (const block of blocks) {
    let parsed
    try {
      parsed = JSON.parse(decodeEntities(block[1]).trim())
    } catch {
      continue
    }
    const queue = Array.isArray(parsed) ? [...parsed] : [parsed]
    while (queue.length > 0) {
      const node = queue.shift()
      if (!node || typeof node !== 'object') continue
      if (Array.isArray(node['@graph'])) queue.push(...node['@graph'])
      const type = node['@type']
      const types = Array.isArray(type) ? type : [type]
      if (types.some((entry) => String(entry).toLowerCase() === 'jobposting')) found.push(node)
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) queue.push(value)
        if (Array.isArray(value)) queue.push(...value)
      }
    }
  }
  return found
}

function stripTags(html) {
  return htmlToText(String(html ?? ''))
}

function pickTitle(anchorHtml) {
  const text = stripTags(anchorHtml).replace(/\s+/g, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

/** 按链接特征从列表页抽岗位；同一 URL 只留一条。 */
export function extractAnchors(html, linkPattern) {
  const pattern = linkPattern instanceof RegExp ? linkPattern : new RegExp(linkPattern, 'gi')
  const jobs = []
  const seen = new Set()
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchorRe.exec(String(html ?? ''))) !== null) {
    const attrs = match[1] ?? ''
    const hrefMatch = attrs.match(/href\s*=\s*"([^"]+)"/i) ?? attrs.match(/href\s*=\s*'([^']+)'/i)
    if (!hrefMatch) continue
    const href = decodeEntities(hrefMatch[1])
    pattern.lastIndex = 0
    if (!pattern.test(href)) continue
    const title = pickTitle(match[2])
    if (title.length < 4) continue
    const absolute = href.startsWith('http') ? href : `/${href.replace(/^\/+/, '')}`
    if (seen.has(absolute)) continue
    seen.add(absolute)
    jobs.push({ href: absolute, title })
  }
  return jobs
}

export function createBrowserSource(config) {
  const descriptor = Object.freeze({
    id: config.id,
    label: config.label,
    kind: 'browser',
    home: config.home,
    note: config.note,
    needsBrowser: true,
  })

  async function search(options = {}) {
    const keywords = Array.isArray(options.keywords) ? options.keywords.join(' ') : String(options.keywords ?? '')
    const started = Date.now()
    let html = ''
    try {
      html = await renderPage({
        url: config.searchUrl(keywords),
        timeoutMs: options.timeoutMs ?? 40000,
        settleMs: options.settleMs ?? 1800,
        waitFor: config.waitFor,
        profile: options.profile,
        executable: options.executable,
        headless: options.headless,
      })
    } catch (error) {
      return { source: config.id, jobs: [], warnings: [{ code: 'E_BROWSER', note: String(error?.message ?? error) }], ms: Date.now() - started, blocked: false }
    }

    if (config.blocked && config.blocked.test(html)) {
      return {
        source: config.id,
        jobs: [],
        warnings: [{ code: 'E_BLOCKED', note: config.blockedNote ?? '站点要求人工验证；跑一次 `node bundle/bin/cli.mjs browser-login <站点>` 打开窗口手动过验证' }],
        blocked: true,
        ms: Date.now() - started,
      }
    }

    const ld = extractJsonLd(html)
    let jobs = []
    if (ld.length > 0) {
      jobs = ld.map((node, index) => {
        const url = typeof node.url === 'string' ? node.url : node.url?.url ?? ''
        const org = node.hiringOrganization
        return {
          key: `${config.id}:${url || index}`,
          source: config.id,
          sourceLabel: config.label,
          nativeId: String(url || index),
          id: String(url || index),
          title: String(node.title ?? node.name ?? '').trim(),
          company: String(org?.name ?? ''),
          salaryLabel: '',
          locations: [node.jobLocation?.address?.addressLocality ?? ''].filter(Boolean),
          workTypes: [node.employmentType ?? ''].flat().filter(Boolean),
          classifications: [],
          listedAt: String(node.datePosted ?? ''),
          teaser: stripTags(node.description ?? '').slice(0, 200),
          url,
          detailRef: { url },
          detail: stripTags(node.description ?? '') ? { contentText: stripTags(node.description), contentChars: stripTags(node.description).length, source: 'jsonld', lite: false } : null,
        }
      })
    } else {
      const anchors = extractAnchors(html, config.linkPattern)
      jobs = anchors.map((entry) => ({
        key: `${config.id}:${entry.href}`,
        source: config.id,
        sourceLabel: config.label,
        nativeId: entry.href,
        id: entry.href,
        title: entry.title,
        company: '',
        salaryLabel: '',
        locations: [],
        workTypes: [],
        classifications: [],
        listedAt: '',
        teaser: '',
        url: entry.href.startsWith('http') ? entry.href : `${config.home}${entry.href}`,
        detailRef: { url: entry.href },
        detail: null,
      }))
    }

    const warnings = []
    if (jobs.length === 0) {
      warnings.push({ code: 'E_NO_PARSER', note: config.emptyNote ?? '页面渲染出来了但没解析到岗位；站点改版或需要登录' })
    }
    return { source: config.id, jobs, totalCount: jobs.length, warnings, ms: Date.now() - started, blocked: false }
  }

  /** 把一个详情页 HTML 解析成统一 detail（JSON-LD 优先，整页文本兜底）。 */
  function parseDetailHtml(html, job) {
    const ld = extractJsonLd(html)
    if (ld.length > 0) {
      const text = stripTags(ld[0].description ?? '')
      if (text.length > 0) {
        return {
          ok: true,
          detail: {
            id: job.id,
            contentText: text,
            contentChars: text.length,
            contentHtml: String(ld[0].description ?? ''),
            source: 'jsonld',
            lite: false,
            salary: '',
            location: '',
            companyProfile: null,
          },
          warnings: [],
        }
      }
    }
    const fallback = stripTags(html)
    if (fallback.length > 200) {
      return {
        ok: true,
        detail: { id: job.id, contentText: fallback.slice(0, 20000), contentChars: fallback.length, contentHtml: '', source: 'dom', lite: false, salary: '', location: '', companyProfile: null },
        warnings: [{ code: 'E_NO_PARSER', note: 'JSON-LD 没找到，退回整页文本' }],
      }
    }
    return { ok: false, code: 'E_PARSE_FAILED', detail: null, warnings: [] }
  }

  async function fetchDetail(job, options = {}) {
    if (options.existing?.contentText) {
      return { ok: true, detail: options.existing, warnings: [] }
    }
    if (job?.detail?.contentText) {
      return { ok: true, detail: { ...job.detail, id: job.id }, warnings: [] }
    }
    const url = job?.url ?? ''
    if (!url) return { ok: false, code: 'E_BAD_PARAM', detail: null, warnings: [] }
    try {
      const html = await renderPage({ url, timeoutMs: 35000, settleMs: 1500, waitFor: config.detailWaitFor })
      return parseDetailHtml(html, job)
    } catch (error) {
      return { ok: false, code: 'E_BROWSER', detail: null, warnings: [{ code: 'E_BROWSER', note: String(error?.message ?? error) }] }
    }
  }

  /**
   * 批量抓详情：共用一个浏览器会话连续打开多页，比逐条 fetchDetail 快一个数量级。
   * 返回结果顺序与 jobs 一致。
   */
  async function fetchDetails(jobs, options = {}) {
    const list = Array.isArray(jobs) ? jobs : []
    if (list.length === 0) return []
    const targets = list.filter((job) => job?.url && !job.detail?.contentText)
    if (targets.length === 0) return list.map((job) => ({ ok: true, detail: { ...job.detail, id: job.id }, warnings: [] }))
    const pages = await renderPages({
      urls: targets.map((job) => job.url),
      timeoutMs: options.timeoutMs ?? 40000,
      settleMs: options.settleMs ?? 700,
      waitFor: config.detailWaitFor,
      profile: options.profile,
      executable: options.executable,
      headless: options.headless,
    })
    const byUrl = new Map(pages.map((page) => [page.url, page]))
    return list.map((job) => {
      if (job?.detail?.contentText) return { ok: true, detail: { ...job.detail, id: job.id }, warnings: [] }
      const page = byUrl.get(job?.url ?? '')
      if (!page || !page.html) {
        return { ok: false, code: 'E_BROWSER', detail: null, warnings: [{ code: 'E_BROWSER', note: page?.error ?? 'render failed' }] }
      }
      return parseDetailHtml(page.html, job)
    })
  }

  return { descriptor, search, fetchDetail, fetchDetails }
}
