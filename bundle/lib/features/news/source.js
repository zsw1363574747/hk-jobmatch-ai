/**
 * 公司新闻（5.6.19）：Google News RSS 检索公司名，按业务 / 财务 / 劳资三类打标。
 * 零依赖：手写 RSS 解析；联网走 lib/net.js。
 */
import { fail } from '../../errors.js'
import { fetchText } from '../../net.js'

const NEWS_TAGS = Object.freeze([
  {
    tag: '人事',
    test: /appoint|appointment|names?\s+(?:new\s+)?(?:ceo|cfo|coo|cto|director|head|chief)|resign|steps?\s+down|retire|promot|joins?\s+as|hires?\b|人事|任命|委任|升任|接任|離任|離職|辭任|辭職|高層|主管|總裁|董事|裁員|挖角/i,
  },
  {
    tag: '发展',
    test: /expan|invest|funding|ipo|new\s+market|strategy|growth|opens?\s+(?:new\s+)?(?:office|store|plant|hub|centre|center)|acquisition|merger|partnership|joint\s+venture|擴張|擴展|投資|融資|上市|新業務|布局|佈局|發展|開設|新店|收購|併購|合作|合資/i,
  },
  {
    tag: '财务',
    test: /revenue|profit|loss|earnings|financial|funding|ipo|valuation|turnover|營收|利潤|虧損|融資|上市|股價|業績/i,
  },
  {
    tag: '劳资',
    test: /layoff|redundanc|union|strike|wage|lawsuit|dispute|labour|labor|裁員|裁員|勞資|工會|欠薪|訴訟|罷工|糾紛/i,
  },
  {
    tag: '业务',
    test: /launch|partner|acquisition|merger|expansion|contract|product|deal|合作|收購|併購|擴張|合約|業務/i,
  },
])

const DEFAULT_FEED = 'https://news.google.com/rss/search'
const MAX_ITEMS = 12
const KEEP_DAYS = 120

function stripCdata(value) {
  return String(value ?? '')
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
}

function decodeXml(value) {
  return stripCdata(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function firstTag(block, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
  return match ? decodeXml(match[1]).trim() : ''
}

function tagOf(text) {
  return NEWS_TAGS.filter((item) => item.test.test(text)).map((item) => item.tag)
}

/**
 * 解析 Google News RSS。返回 { items:[{title, link, source, date, tags}] }
 */
export function parseNewsRss(xml, { limit = MAX_ITEMS } = {}) {
  const text = String(xml ?? '')
  const items = []
  const seen = new Set()
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000
  for (const match of text.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]
    const title = firstTag(block, 'title')
    const link = firstTag(block, 'link')
    if (!title || !link || seen.has(title)) continue
    const source = firstTag(block, 'source')
    const pubDate = firstTag(block, 'pubDate')
    const stamp = Date.parse(pubDate)
    if (Number.isFinite(stamp) && stamp < cutoff) continue
    seen.add(title)
    items.push({
      title,
      link,
      source,
      date: Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : '',
      tags: tagOf(`${title} ${source}`),
    })
    if (items.length >= limit) break
  }
  return { items }
}

/**
 * 抓公司新闻：Google News RSS。
 * 除了「公司名 + 香港」的泛搜，还针对「人事变动」和「未来发展」各发中英文定向查询，
 * 因为泛搜对这些内容命中率很低（很多任命/扩张新闻标题里并不带城市名）。
 */
export async function fetchCompanyNews(company, options = {}) {
  const name = String(company ?? '').trim()
  if (name === '') {
    throw Object.assign(fail('E_BAD_PARAM'), { step: 'fetchCompanyNews', expected: 'company name' })
  }
  const limit = Math.min(MAX_ITEMS, Math.max(1, Number(options.limit) || MAX_ITEMS))
  const httpText = options.fetchText ?? fetchText
  const quoted = `"${name}"`
  const feeds = [
    // 泛搜
    { q: `${name} 香港`, hl: 'zh-HK', gl: 'HK', ceid: 'HK:zh-Hant' },
    { q: `${quoted} Hong Kong`, hl: 'en-HK', gl: 'HK', ceid: 'HK:en' },
    // 人事变动：任命 / 离任 / 高层 / 裁员
    { q: `${quoted} 任命 OR 委任 OR 離任 OR 離職 OR 裁員 OR 高層`, hl: 'zh-HK', gl: 'HK', ceid: 'HK:zh-Hant' },
    { q: `${quoted} appoint OR "chief executive" OR director OR resign OR "steps down"`, hl: 'en-HK', gl: 'HK', ceid: 'HK:en' },
    // 未来发展：扩张 / 投资 / 收购 / 新业务
    { q: `${quoted} 擴張 OR 投資 OR 融資 OR 收購 OR 新業務 OR 發展`, hl: 'zh-HK', gl: 'HK', ceid: 'HK:zh-Hant' },
    { q: `${quoted} expansion OR investment OR acquisition OR "joint venture" OR strategy OR "new market"`, hl: 'en-HK', gl: 'HK', ceid: 'HK:en' },
  ].map((feed) => `${DEFAULT_FEED}?q=${encodeURIComponent(feed.q)}&hl=${feed.hl}&gl=${feed.gl}&ceid=${feed.ceid}`)

  const needle = name.toLowerCase()
  // 公司全名往往写成「Yusen Logistics Global Management (Hong Kong) Limited」，
  // 新闻标题里只会出现前两个词；这里给出「全名 / 去掉括号与法律后缀 / 前两个词」三级候选，
  // 避免只拿单个单词去匹配（「Watson」会把篮球新闻也捞进来）。
  const cleaned = name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(limited|ltd|inc|co|corp|corporation|group|holdings|company|plc|international)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const firstTwo = cleaned.split(' ').filter(Boolean).slice(0, 2).join(' ')
  const candidates = [...new Set([needle, cleaned.toLowerCase(), firstTwo.toLowerCase()])].filter(
    (entry) => entry.length >= 4,
  )
  const patterns = candidates.map(
    (entry) => new RegExp(`(^|[^a-z0-9])${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i'),
  )
  const relevant = (item) => patterns.some((pattern) => pattern.test(item.title))

  // 六个 feed 并发拉，别让用户等六轮往返
  const settled = await Promise.all(
    feeds.map((url) =>
      httpText(url, { headers: { 'user-agent': 'Mozilla/5.0' }, fetchImpl: options.fetchImpl })
        .then((xml) => ({ ok: true, xml }))
        .catch((error) => ({ ok: false, code: error?.code ?? 'E_INTERNAL' })),
    ),
  )

  const errors = settled.filter((entry) => !entry.ok).map((entry) => entry.code)
  const merged = []
  const seen = new Set()
  for (const entry of settled) {
    if (!entry.ok) continue
    for (const item of parseNewsRss(entry.xml, { limit: limit * 3 }).items) {
      if (!relevant(item)) continue
      if (seen.has(item.title)) continue
      seen.add(item.title)
      merged.push({ ...item, match: item.title.toLowerCase().includes(needle) ? 'name' : 'alias' })    }
  }
  if (merged.length === 0 && errors.length === feeds.length) {
    throw Object.assign(fail('E_NETWORK'), { step: 'fetchCompanyNews' })
  }

  // 用户关心的是人岗变动和公司走向：带这两类标签的排前面，其余按时间倒序
  const priority = (item) => (item.tags.includes('人事') ? 0 : item.tags.includes('发展') ? 1 : 2)
  merged.sort((left, right) => {
    const byTopic = priority(left) - priority(right)
    if (byTopic !== 0) return byTopic
    return String(right.date).localeCompare(String(left.date))
  })
  return { ok: true, company: name, items: merged.slice(0, limit), errors }
}
