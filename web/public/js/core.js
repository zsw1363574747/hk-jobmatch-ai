const boot = globalThis.__JOBMATCH__ ?? {}

export const token = boot.token ?? ''

export const state = {
  profile: null,
  run: null,
  reports: new Map(),
  lang: 'zh',
  translations: {},
  newsCache: {},
  activeJob: null,
  activeId: null,
  detailLoaded: new Set(),
  rescoreTimer: null,
  // 当前只启用 JobsDB；CTgoodjobs 停用但保留，旧 run 里的来源标签还要用。
  sources: ['jobsdb'],
  // 地点用 JobsDB 的 location label；空数组 = 全港。
  locations: [],
  locationGroups: [],
  locationError: '',
  loggedIn: false,
  postedWithinWeeks: 4,
}

export const bus = new EventTarget()

export const $ = (id) => document.getElementById(id)

/** 跨站唯一键：同一个数字 id 在两家站上可能撞车，所以用 source:nativeId。 */
export function jobKey(job) {
  if (!job) return ''
  return String(job.key ?? `${job.source ?? 'jobsdb'}:${job.id}`)
}

export const JOB_SOURCE_LABEL = { jobsdb: 'JobsDB', ctgoodjobs: 'CTgoodjobs' }

export const WEIGHT_META = [
  { key: 'skills', label: '技能', hint: '简历技能在 JD 里命中的比例' },
  { key: 'title', label: '职位名', hint: 'JD 标题和你目标职位的相似度' },
  { key: 'domain', label: '领域', hint: 'JD 分类和你的行业是否一致' },
  { key: 'location', label: '地点', hint: '是否符合你填的地点' },
  { key: 'workType', label: '工作类型', hint: '全职 / 兼职 / 合同' },
  { key: 'freshness', label: '新鲜度', hint: '7 / 14 / 30 天内发布' },
  { key: 'experience', label: '经验', hint: '经验达标程度（不达标另乘折扣）' },
]

export const DEFAULT_WEIGHTS = { skills: 30, title: 15, domain: 12, location: 8, workType: 5, freshness: 10, experience: 20 }

export const SOURCE_LABEL = { jd: 'JD 正文', 'search-api': '搜索摘要', teaser: '搜索摘要', manual: '手动粘贴', cache: '缓存' }

export const INDUSTRY_FROM = { jd: 'JD 原文', classification: '岗位分类', title: '岗位标题', employer: '雇主行业' }

export const SALARY_SOURCE_LABEL = {
  'jd-field': 'JD 原文',
  'jd-text': 'JD 正文',
  'platform-filter': '平台筛选',
  'platform-match': '平台匹配',
  'cross-platform': '跨平台',
  'sibling-posting': '同公司岗位',
  benchmark: '推断',
}

export function setMsg(id, text, kind = 'hint') {
  const node = $(id)
  if (!node) return
  node.textContent = text ?? ''
  node.className = kind
}

export async function api(path, { method = 'POST', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-jobmatch-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return response.json().catch(() => ({ ok: false, code: 'E_INTERNAL', message: '响应不是 JSON' }))
}

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  )
}

export function titleOf(job) {
  if (state.lang === 'zh' && state.translations[job.id]) return state.translations[job.id]
  return job.title
}

export function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }))
}
