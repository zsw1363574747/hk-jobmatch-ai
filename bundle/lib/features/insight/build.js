/**
 * JD 要求聚合（v3）：把 run 里已抓的 JD 正文按「能力项」统计出现频次。
 *
 * v3 的取舍：学历、语言不算「能力」，不再进排行，只在末尾当背景信息给一行百分比。
 *
 * - 词表：bundle/data/lexicon.json 的 63 个技能（含中英文同义词）+ 少量补充说法；
 * - 只统计「Requirements / Qualifications / 任职要求」段落，找不到才退回全文；
 * - 每项给出「出现的 JD 条数 / 占比 / 总提及次数」，并按 数据 · 工具 · 技术 · 方法 · 产品 分组；
 * - 支持合并多个 run（本轮 + 历史），按 job key 去重后统计。
 *
 * 纯规则、零依赖，不调用模型。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail } from '../../errors.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LEXICON_PATH = join(HERE, '..', '..', '..', 'data', 'lexicon.json')

/** 词表里没覆盖到、但中文 JD 常写的说法。 */
const EXTRA_SYNONYMS = Object.freeze({
  PRD: ['需求文档', '需求规格'],
  Roadmap: ['产品规划'],
  Agile: ['迭代'],
  Excel: ['数据透视表'],
  'Stakeholder Management': ['利益相关方', '干系人'],
  'Competitive Analysis': ['竞品分析'],
  'User Research': ['用户调研', '用户研究'],
  'Data Visualization': ['数据可视化'],
  Dashboard: ['看板', '仪表盘'],
  Prototyping: ['原型'],
  'Machine Learning': ['机器学习'],
  JIRA: ['jira', 'confluence'],
})

/** 能力分组：学历 / 语言不在这里。 */
const CATEGORIES = Object.freeze([
  { id: 'data', label: '数据 / 分析' },
  { id: 'tools', label: '工具 / 平台' },
  { id: 'tech', label: '技术 / 工程' },
  { id: 'method', label: '方法 / 流程' },
  { id: 'product', label: '产品 / 协作' },
])

const CATEGORY_OF = Object.freeze({
  SQL: 'data',
  Python: 'data',
  R: 'data',
  Statistics: 'data',
  'A/B Testing': 'data',
  'Data Analysis': 'data',
  'Data Visualization': 'data',
  Dashboard: 'data',
  'Data Warehouse': 'data',
  'Data Modeling': 'data',
  'Analytics Tracking': 'data',
  'Search Analytics': 'data',
  BigQuery: 'data',
  Snowflake: 'data',
  Spark: 'data',
  Hadoop: 'data',
  Kafka: 'data',
  ETL: 'data',
  Airflow: 'data',
  dbt: 'data',
  Excel: 'tools',
  'Power BI': 'tools',
  Tableau: 'tools',
  Looker: 'tools',
  Figma: 'tools',
  Axure: 'tools',
  JIRA: 'tools',
  Git: 'tools',
  Docker: 'tools',
  'Low-code': 'tools',
  CRM: 'tools',
  'Machine Learning': 'tech',
  NLP: 'tech',
  Java: 'tech',
  Scala: 'tech',
  AWS: 'tech',
  Azure: 'tech',
  GCP: 'tech',
  Recommendation: 'tech',
  Agile: 'method',
  'Requirement Analysis': 'method',
  'User Research': 'method',
  'Competitive Analysis': 'method',
  Roadmap: 'method',
  PRD: 'method',
  Prototyping: 'method',
  'Project Management': 'method',
  OKR: 'method',
  Persona: 'method',
  'Product Owner': 'product',
  'Go-to-Market': 'product',
  Growth: 'product',
  Retention: 'product',
  Conversion: 'product',
  Pricing: 'product',
  'GMV/GTV': 'product',
  Merchandising: 'product',
  Fulfillment: 'product',
  Operations: 'product',
  'Route Planning': 'product',
  'Stakeholder Management': 'product',
  'AI Product': 'product',
  'UI/UX': 'product',
})

/** 背景信息：不算能力，单独一行给百分比。 */
const CONTEXT_DEFS = Object.freeze([
  { label: '学历要求', patterns: ['bachelor', 'degree', 'university', 'diploma', '学历', '本科', '大专'] },
  { label: '英语', patterns: ['english', '英文', '英语'] },
  { label: '普通话', patterns: ['mandarin', '普通话', 'putonghua'] },
  { label: '粤语', patterns: ['cantonese', '粵語', '粤语'] },
])

/** 「要求」段落标题：命中后从该行取到文末（有长度上限）。 */
const SECTION_HEADING =
  /^[ \t]*(?:(?:job|key|main|basic|minimum|preferred)\s+)?(?:requirements?|qualifications?|required\s+(?:skills|experience|qualifications)|what\s+(?:we|you)(?:'|’)?(?:re|ll)?\s*(?:looking|need)|who\s+you\s+are|your\s+profile|任职要求|岗位要求|职位要求|任职资格|资格要求|学历要求|工作要求|职位需求)[ \t]*[:：]?[ \t]*$/gim

const SECTION_MAX_CHARS = 6000
const SECTION_MIN_CHARS = 80

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

function toRegex(pattern) {
  const raw = String(pattern ?? '').trim().toLowerCase()
  if (!raw) return null
  const body = raw.replace(REGEX_SPECIALS, '\\$&').replace(/\s+/g, '\\s+')
  // 英文/数字开头结尾的加边界，避免 sql 命中 mysql、ai 命中 detail 这类误判。
  const left = /^[a-z0-9]/.test(raw) ? '(?<![a-z0-9])' : ''
  const right = /[a-z0-9]$/.test(raw) ? '(?![a-z0-9])' : ''
  try {
    return new RegExp(`${left}${body}${right}`, 'gi')
  } catch {
    return null
  }
}

function loadLexicon() {
  try {
    return JSON.parse(readFileSync(LEXICON_PATH, 'utf8'))
  } catch {
    return { skills: [] }
  }
}

function defsOf(entries, categoryOf) {
  return entries
    .map((term) => ({
      label: term.label,
      category: categoryOf ? categoryOf[term.label] : undefined,
      regexes: (term.patterns ?? []).map(toRegex).filter(Boolean),
    }))
    .filter((term) => term.regexes.length > 0)
}

/** 能力词条；学历 / 语言在 CONTEXT_DEFS。 */
const TERM_DEFS = (() => {
  const lexicon = loadLexicon()
  const drafts = (lexicon.skills ?? []).map((skill) => ({
    label: skill.label,
    patterns: [...(skill.patterns ?? []), ...(EXTRA_SYNONYMS[skill.label] ?? [])],
  }))
  return defsOf(drafts, CATEGORY_OF)
})()

const CONTEXT_TERMS = defsOf(CONTEXT_DEFS, null)

export const INSIGHT_TERMS = Object.freeze(TERM_DEFS.map((term) => term.label))

/** 取「要求」段落；取不到或太短就退回全文（不丢掉没分段的 JD）。 */
function requirementsText(text) {
  SECTION_HEADING.lastIndex = 0
  const match = SECTION_HEADING.exec(text)
  if (!match) return text
  const section = text.slice(match.index, match.index + SECTION_MAX_CHARS).trim()
  return section.length >= SECTION_MIN_CHARS ? section : text
}

const YEAR_BUCKETS = ['1–2 年', '3–4 年', '5–7 年', '8 年以上']

function bucketOf(years) {
  if (years <= 2) return YEAR_BUCKETS[0]
  if (years <= 4) return YEAR_BUCKETS[1]
  if (years <= 7) return YEAR_BUCKETS[2]
  return YEAR_BUCKETS[3]
}

function yearsOf(text) {
  let max = 0
  for (const match of text.matchAll(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi)) {
    const value = Number(match[1])
    if (Number.isInteger(value) && value > 0 && value <= 30) max = Math.max(max, value)
  }
  return max
}

function countMatches(regexes, text) {
  let total = 0
  for (const regex of regexes) {
    regex.lastIndex = 0
    const found = text.match(regex)
    if (found) total += found.length
  }
  return total
}

/** 用规则写一段「为什么数据是这样 + 能得到什么结论」，只做解释，不改动统计口径。 */
function summarize({ ranked, groups, context, jdCount, runCount, gaps, covered, rankedCount }) {
  const top = ranked[0]
  if (!top) {
    return { headline: '这批 JD 里没识别出能力项：可能正文没抓到，或要求都写在「要求段落」之外。', why: [], conclusion: [] }
  }
  const second = ranked[1]
  const catPct = (id) => groups.find((group) => group.id === id)?.terms[0]?.pct ?? 0
  const softMax = Math.max(catPct('method'), catPct('product'))
  const hardMax = Math.max(catPct('data'), catPct('tools'), catPct('tech'))
  const pool = ranked.reduce((sum, term) => sum + term.count, 0) || 1
  const top3 = ranked.slice(0, 3)
  const top3Share = Math.round((top3.reduce((sum, term) => sum + term.count, 0) / pool) * 100)
  const tailCount = ranked.filter((term) => term.pct <= 5).length
  const degree = context.find((item) => item.label === '学历要求')?.pct ?? 0
  const english = context.find((item) => item.label === '英语')?.pct ?? 0

  const headline = `${jdCount} 条 JD 里提得最多的是「${top.label}」（${top.pct}%）${
    second ? `，其次是「${second.label}」（${second.pct}%）` : ''
  }——${
    hardMax > softMax
      ? '硬技能要求比流程类更突出'
      : softMax > hardMax
        ? '要求集中在流程与协作，硬技能只作加分项'
        : '流程类和硬技能的分量差不多'
  }。`

  const backgroundBits = []
  if (degree >= 20) backgroundBits.push(`学历要求 ${degree}%`)
  if (english >= 20) backgroundBits.push(`英语 ${english}%`)
  const why = [
    `口径：只统计「要求」段落里的 ${TERM_DEFS.length} 个能力词，样本 ${jdCount} 条${
      runCount > 1 ? `（合并 ${runCount} 轮、按岗位去重）` : ''
    }——这是「JD 写出来的要求」，不等于岗位真实需要的全部能力。`,
    hardMax > softMax
      ? `结构：硬技能最高到 ${hardMax}%，高于流程类的 ${softMax}%，说明这些岗位把工具/数据能力写成了显性门槛。`
      : softMax > hardMax
        ? `结构：方法/流程与产品/协作最高到 ${softMax}%，数据、工具、技术类最高只有 ${hardMax}%。这类 JD 习惯先写职责与协作方式，工具往往放在加分项里，所以排序天然偏软技能。`
        : `结构：流程类与硬技能的最高占比都是 ${softMax}%，两类分量相当。`,
    `集中度：前 3 项（${top3.map((term) => term.label).join('、')}）占全部能力提及的 ${top3Share}%${
      tailCount > 0 ? `，另有 ${tailCount} 项都在 5% 以下——JD 措辞高度模板化，长尾差异大` : ''
    }。`,
    backgroundBits.length > 0
      ? `背景：${backgroundBits.join('、')} 出现率很高，属于香港招聘的通用模板，不能当能力区分，已单独放进背景行。`
      : `背景：学历要求 ${degree}%、英语 ${english}%，出现率不高，说明这批 JD 没在学历语言上卡人。`,
  ]
  if (jdCount < 10) why.push(`样本只有 ${jdCount} 条，百分比很不稳，只能当参考，别当市场结论。`)

  const conclusion = []
  if (gaps.length > 0) {
    conclusion.push(
      `补能力的优先级：先补「${gaps[0].label}」（${gaps[0].pct}% 的 JD 提到、简历没写）${
        gaps[1] ? `，其次「${gaps[1].label}」（${gaps[1].pct}%）` : ''
      }。`,
    )
  } else {
    conclusion.push('榜单上的能力简历都已覆盖，差距更可能在年限、行业或语言上（看上方年限分布）。')
  }
  conclusion.push(
    `简历覆盖 ${covered}/${rankedCount} 项；「缺口」是词面匹配，中文写法不同（如「项目管理」没被识别成 Project Management）会误报，真要补之前先人工核对。`,
  )
  conclusion.push(
    `样本局限：${jdCount} 条来自 ${runCount > 1 ? `${runCount} 轮关键词搜索` : '一次关键词搜索'}，换关键词或地区排名就会变。要做「市场普遍要求」的结论，多抓几组关键词再合并（勾选「合并历史 run」）。`,
  )

  return { headline, why, conclusion }
}

/**
 * @param runOrRuns 单个 run，或按「新 → 旧」排好的 run 数组
 * @returns {{jdCount:number, terms:Array, groups:Array, context:Array, years:Array, companies:Array, missing:number, runCount:number}}
 */
export function buildInsight(runOrRuns) {
  const runs = (Array.isArray(runOrRuns) ? runOrRuns : [runOrRuns]).filter((run) => run && typeof run === 'object')
  if (runs.length === 0) {
    throw Object.assign(fail('E_BAD_PARAM'), { step: 'buildInsight', expected: 'run object or run array' })
  }

  // 同一个岗位可能出现在多轮搜索里：按 key 去重，先出现的（更新的 run）优先。
  const details = []
  const seen = new Set()
  const jobs = new Set()
  const companiesById = new Map()
  for (const run of runs) {
    for (const job of run.jobs ?? []) {
      jobs.add(String(job.key ?? job.id))
      companiesById.set(String(job.id), job.company ?? '')
      if (job.key) companiesById.set(String(job.key), job.company ?? '')
    }
    for (const [ref, detail] of Object.entries(run.details ?? {})) {
      if (!detail || typeof detail.contentText !== 'string' || detail.contentText.length <= 40) continue
      if (seen.has(ref)) continue
      seen.add(ref)
      details.push({ ref, detail })
    }
  }

  const terms = TERM_DEFS.map((term) => ({ label: term.label, category: term.category, count: 0, mentions: 0, companies: [] }))
  const context = CONTEXT_TERMS.map((term) => ({ label: term.label, count: 0 }))
  const years = YEAR_BUCKETS.map((bucket) => ({ bucket, count: 0 }))
  const companies = new Map()

  for (const { ref, detail } of details) {
    const text = requirementsText(detail.contentText)
    const company = companiesById.get(String(detail.id)) || companiesById.get(String(ref)) || detail.company || ''
    if (company) companies.set(company, (companies.get(company) ?? 0) + 1)
    for (let index = 0; index < TERM_DEFS.length; index += 1) {
      const hits = countMatches(TERM_DEFS[index].regexes, text)
      if (hits === 0) continue
      terms[index].count += 1
      terms[index].mentions += hits
      if (company && terms[index].companies.length < 3 && !terms[index].companies.includes(company)) {
        terms[index].companies.push(company)
      }
    }
    for (let index = 0; index < CONTEXT_TERMS.length; index += 1) {
      if (countMatches(CONTEXT_TERMS[index].regexes, text) > 0) context[index].count += 1
    }
    const yearsValue = yearsOf(text)
    if (yearsValue > 0) {
      const bucket = years.find((item) => item.bucket === bucketOf(yearsValue))
      if (bucket) bucket.count += 1
    }
  }

  const jdCount = details.length
  const pctOf = (count) => (jdCount > 0 ? Math.round((count / jdCount) * 100) : 0)
  // 简历里已经写过的能力：用最新一轮 run 的 profile.skills 判断，用来区分「要求」和「缺口」。
  const profileSkills = new Set((runs[0]?.profile?.skills ?? []).map((skill) => String(skill).toLowerCase()))
  const ranked = terms
    .filter((term) => term.count > 0)
    .map((term) => ({ ...term, pct: pctOf(term.count), have: profileSkills.has(term.label.toLowerCase()) }))
    .sort((left, right) => right.count - left.count || right.mentions - left.mentions || left.label.localeCompare(right.label))

  // 分组：每组最多 4 条，组按「最强项」排序。
  const groups = CATEGORIES.map((category) => {
    const rows = ranked.filter((term) => term.category === category.id).slice(0, 4)
    return { id: category.id, label: category.label, terms: rows, top: rows[0]?.count ?? 0 }
  })
    .filter((group) => group.terms.length > 0)
    .sort((left, right) => right.top - left.top)

  const gaps = ranked
    .filter((term) => !term.have)
    .slice(0, 5)
    .map((term) => ({ label: term.label, pct: term.pct, count: term.count }))
  const covered = ranked.filter((term) => term.have).length
  const contextStats = context.filter((item) => item.count > 0).map((item) => ({ ...item, pct: pctOf(item.count) }))
  const summary = summarize({ ranked, groups, context: contextStats, jdCount, runCount: runs.length, gaps, covered, rankedCount: ranked.length })

  return {
    runCount: runs.length,
    runIds: runs.map((run) => run.runId ?? ''),
    jdCount,
    missing: Math.max(0, jobs.size - jdCount),
    terms: ranked.slice(0, 15),
    groups,
    gaps,
    covered,
    rankedCount: ranked.length,
    summary,
    context: contextStats,
    years: years.filter((item) => item.count > 0),
    companies: [...companies.entries()]
      .map(([company, count]) => ({ company, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  }
}
