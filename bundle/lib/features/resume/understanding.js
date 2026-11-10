/**
 * 简历理解：不是「扫关键词」，而是先把简历读成结构（做了什么 → 在哪家公司 → 成果），
 * 再从结构里反推关键词与搜索用词。
 *
 * 纯本地规则，不联网、不依赖模型：
 *   1. 按小标题切段（简介 / 工作经历 / 项目 / 教育 / 技能…）
 *   2. 从工作经历里切出「职位段」：日期区间 + 职位 + 公司
 *   3. 职位段里的每条要点 → 动作（动词）+ 对象 + 工具 + 量化结果
 *   4. 汇总成：一句话概述、每段经历做了什么、量化成果、关键词（带证据）
 */

const SECTION_DEFS = [
  { key: 'summary', re: /^(summary|profile|objective|about\s*(me)?|professional\s+summary|个人简介|个人优势|自我评价|个人概述|简介)/i },
  { key: 'experience', re: /^(work\s+experience|professional\s+experience|employment(\s+history)?|experience|work\s+history|career\s+history|实习经历|实习经验|工作经历|工作经验|职业经历|履历)/i },
  { key: 'projects', re: /^(projects?|selected\s+projects|项目经历|项目经验)/i },
  { key: 'education', re: /^(education|academic|教育背景|教育经历|学历)/i },
  { key: 'skills', re: /^(skills|technical\s+skills|core\s+skills|competenc(y|ies)|个人技能|专业技能|技能|核心技能)/i },
  { key: 'certs', re: /^(certifications?|certificates?|licen[cs]es?|证书|资格证书)/i },
  { key: 'awards', re: /^(awards?|honors?|honours?|achievements?|获奖|荣誉|奖项)/i },
]

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
const DATE_TOKEN = `(?:${MONTH}\\s*\\d{2,4}|\\d{4}\\s*[-/.]\\s*\\d{1,2}|\\d{1,2}\\s*[-/.]\\s*\\d{4}|\\d{4}\\s*年(?:\\s*\\d{1,2}\\s*月)?|\\d{4})`
const DATE_RANGE_RE = new RegExp(`(${DATE_TOKEN})\\s*(?:-|–|—|~|to|至|到)\\s*(${DATE_TOKEN}|present|current|now|至今|今)`, 'i')
const SINGLE_YEAR_RE = /^(?:19|20)\d{2}\s*(?:年)?$/

const VERBS = new Set([
  'led', 'lead', 'built', 'build', 'designed', 'design', 'developed', 'develop', 'analyzed', 'analysed', 'analyze', 'analyse',
  'automated', 'automate', 'improved', 'improve', 'increased', 'reduce', 'reduced', 'launched', 'launch', 'managed', 'manage',
  'delivered', 'deliver', 'created', 'create', 'implemented', 'implement', 'optimized', 'optimised', 'migrated', 'migrate',
  'collaborated', 'collaborate', 'owned', 'own', 'drove', 'drive', 'established', 'establish', 'mentored', 'mentor',
  'presented', 'present', 'conducted', 'conduct', 'performed', 'perform', 'supported', 'support', 'partnered', 'partner',
  'introduced', 'introduce', 'streamlined', 'streamline', 'rolled', 'spearheaded', 'initiated', 'initiate', 'tracked', 'track',
])

const METRIC_RE = /(\d+(?:\.\d+)?\s?%)|([$HK]?\s?\d[\d,.]*\s?[kKmMbB]\b)|(\d[\d,.]*\s?(?:万|亿|倍|人|条|个|小时|天))|(\b\d[\d,.]{2,}\b)/

/** 常见技术/工具词：词典里没有也能认出来，避免「只认词表」。 */
const TOOL_TERMS = [
  'Python', 'SQL', 'R', 'Excel', 'VBA', 'Power BI', 'PowerBI', 'Tableau', 'Looker', 'Qlik', 'Superset', 'Metabase',
  'Pandas', 'NumPy', 'scikit-learn', 'TensorFlow', 'PyTorch', 'Spark', 'PySpark', 'Hadoop', 'Hive', 'Presto', 'Trino',
  'Airflow', 'dbt', 'Kafka', 'Snowflake', 'BigQuery', 'Redshift', 'Databricks', 'AWS', 'GCP', 'Azure', 'Docker',
  'Kubernetes', 'Git', 'Java', 'Scala', 'Go', 'JavaScript', 'TypeScript', 'Shell', 'Bash', 'SAS', 'SPSS', 'Stata',
  'Google Analytics', 'GA4', 'Mixpanel', 'Amplitude', 'Segment', 'A/B testing', 'ETL', 'ELT', 'data warehouse',
  'data pipeline', 'dashboard', 'machine learning', 'NLP', 'LLM', 'recommendation', 'forecasting', 'segmentation',
  'CRM', 'Salesforce', 'SAP', 'Jira', 'Confluence', 'Figma',
]

const DOMAIN_TERMS = [
  { label: '电商/零售', re: /e-?commerce|retail|电商|零售|商城|门店/i },
  { label: '金融科技', re: /fintech|payment|lending|金融科技|支付|信贷/i },
  { label: '银行/金融', re: /bank(ing)?|financial\s+services|investment\s+bank|银行|金融|证券|投行/i },
  { label: '保险', re: /insurance|保险/i },
  { label: '物流/供应链', re: /logistics|supply\s+chain|warehouse|物流|供应链|仓储/i },
  { label: '医疗/健康', re: /healthcare|medical|pharma|clinical|hospital|医疗|医药|医院/i },
  { label: '游戏/媒体', re: /gaming|media|content|广告|媒体|游戏/i },
  { label: 'SaaS/科技', re: /saas|software|platform|科技|软件|平台/i },
  { label: '教育', re: /education|edtech|教育|培训/i },
  { label: '咨询', re: /consulting|consultant|咨询/i },
]

const SENIOR_RE = /\b(lead|leader|head|manager|director|principal|staff|vp|chief)\b|主管|经理|总监|负责人|首席/i
const JUNIOR_RE = /\b(intern|internship|graduate|junior|assistant|trainee)\b|实习|应届|助理/i

/** 摘要里用的中文说法：词表标签是英文概念（Growth / Fulfillment），直接塞进中文句子很别扭。 */
const DISPLAY_ZH = new Map([
  ['data analysis', '数据分析'],
  ['low-code', '低代码'],
  ['fulfillment', '履约'],
  ['conversion', '转化'],
  ['operations', '运营'],
  ['pricing', '定价'],
  ['route planning', '路线规划'],
  ['growth', '增长'],
  ['retention', '留存'],
  ['recommendation', '推荐'],
  ['search analytics', '搜索分析'],
  ['crm', 'CRM'],
  ['dashboard', '看板'],
  ['stakeholder management', '跨部门协作'],
  ['ai product', 'AI 产品'],
  ['data analysis', '数据分析'],
])

function chineseOf(label) {
  const key = String(label).toLowerCase()
  const titleMap = {
    'product manager': '产品经理',
    'marketing product manager': '营销产品经理',
    'business intelligence analyst': '商业智能分析师',
    'data analyst': '数据分析师',
    'data engineer': '数据工程师',
    'product owner': '产品负责人',
  }
  return DISPLAY_ZH.get(key) ?? titleMap[key] ?? String(label)
}

/** 求职方向：从「做过什么」推，而不是从词表推。 */
const DIRECTION_RULES = [
  {
    label: '产品经理',
    titleRe: /product\s+(manager|owner)|产品经理|产品专员/i,
    textRe: /需求|prd|原型|版本|迭代|产品方案|产品设计|上线效果|功能设计|用户调研|产品规划/i,
    skills: ['Axure', 'Product Manager'],
    keywords: ['product manager', 'assistant product manager'],
  },
  {
    label: '产品运营 / 增长',
    titleRe: /运营|operations|growth/i,
    textRe: /运营|增长|留存|拉新|促活|活动|转化率|点击率|用户分层|复购|gmv|gtv/i,
    skills: ['Growth', 'Operations', 'Conversion', 'CRM'],
    keywords: ['product operations', 'operations executive', 'growth'],
  },
  {
    label: 'AI 产品经理',
    titleRe: /\bai\b|人工智能|llm/i,
    textRe: /llm|大模型|rag|prompt|智能体|agent|生成式|vibe\s*coding|机器学习|aigc/i,
    skills: ['AI Product'],
    keywords: ['AI product manager', 'AI product'],
  },
  {
    label: '数据分析 / 商业分析',
    titleRe: /analyst|分析/i,
    textRe: /sql|数据分析|指标|看板|dashboard|a\/b|取数|数据仓库|埋点/i,
    skills: ['SQL', 'Python', 'Tableau', 'Power BI', 'Excel', 'Data Analysis'],
    keywords: ['data analyst', 'business analyst'],
  },
  {
    label: '项目管理',
    titleRe: /project\s+manager|项目经理|program\s+manager/i,
    textRe: /项目管理|跨部门|推进|交付|排期|协调/i,
    skills: [],
    keywords: ['project manager', 'program management'],
  },
  {
    label: '管培生',
    titleRe: /trainee|graduate|管培/i,
    textRe: /应届|毕业生|graduate|校招|实习/i,
    skills: [],
    keywords: ['management trainee', 'graduate trainee'],
  },
]

function computeDirections(text, titles, skillLabels) {
  const haystack = String(text ?? '')
  const titleText = titles.join(' ')
  const skillSet = new Set(skillLabels.map((label) => String(label).toLowerCase()))
  const rows = []
  for (const rule of DIRECTION_RULES) {
    let score = 0
    const evidence = []
    const titleHit = titles.find((title) => rule.titleRe.test(title))
    if (titleHit) {
      score += 5
      evidence.push(titleHit)
    }
    const textHits = [...new Set((haystack.match(rule.textRe) ?? []).map((item) => item.toLowerCase()))].slice(0, 3)
    if (textHits.length > 0) {
      score += Math.min(4.5, textHits.length * 1.5)
      evidence.push(...textHits)
    }
    const skillHit = (rule.skills ?? []).find((label) => skillSet.has(label.toLowerCase()))
    if (skillHit) {
      score += 1.5
      evidence.push(skillHit)
    }
    if (score >= 3) {
      rows.push({
        label: rule.label,
        score: Number(score.toFixed(1)),
        reason: [...new Set(evidence)].slice(0, 3).join(' · '),
        keywords: rule.keywords,
      })
    }
  }
  return rows.sort((left, right) => right.score - left.score).slice(0, 3)
}
const TITLE_HINTS = [
  { re: /数据分析|数据\s*分析|data\s+analyt|analytics/i, label: 'Data Analyst' },
  { re: /商业智能|business\s+intelligence|\bbi\b|报表/i, label: 'Business Intelligence Analyst' },
  { re: /数据工程|data\s+engineering|etl|数据仓库/i, label: 'Data Engineer' },
  { re: /算法|machine\s+learning|机器学习/i, label: 'Machine Learning Engineer' },
  { re: /产品经理|product\s+manager/i, label: 'Product Manager' },
]

function cleanLine(line) {
  return String(line ?? '')
    .replace(/^[\s•·*\-–—●▪◦]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isHeading(line) {
  const text = cleanLine(line)
  if (text === '' || text.length > 40) return false
  return SECTION_DEFS.some((def) => def.re.test(text))
}

function sectionKey(line) {
  const text = cleanLine(line)
  const hit = SECTION_DEFS.find((def) => def.re.test(text))
  return hit ? hit.key : null
}

/** 把简历切成 { summary, experience, projects, education, skills, certs, awards } 文本块。 */
export function splitSections(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const buckets = new Map()
  const preamble = []
  let current = null // 遇到第一个小标题之前的内容先当「简介」
  let sawHeading = false
  for (const line of lines) {
    const key = sectionKey(line)
    if (key) {
      sawHeading = true
      current = key
      if (!buckets.has(key)) buckets.set(key, [])
      continue
    }
    if (!current) {
      preamble.push(line)
      continue
    }
    if (!buckets.has(current)) buckets.set(current, [])
    buckets.get(current).push(line)
  }
  const out = {}
  for (const [key, value] of buckets) out[key] = value.join('\n').trim()
  const intro = preamble.join('\n').trim()
  // 没有任何小标题：整篇按经历读；有标题但开头有一段自由文本，就归到「简介」
  if (!sawHeading) out.experience = intro
  else if (intro !== '') out.summary = [out.summary, intro].filter(Boolean).join('\n\n')
  return out
}

function splitRoles(experienceText) {
  const lines = String(experienceText ?? '').split(/\r?\n/)
  const blocks = []
  let current = null
  let pendingHeader = null

  const push = () => {
    if (current) blocks.push(current)
    current = null
  }

  for (const raw of lines) {
    const line = cleanLine(raw)
    if (line === '') continue
    const range = DATE_RANGE_RE.exec(line)
    const isBullet = /^[\s•·*\-–—]/.test(raw)
    if (range && line.length <= 160) {
      push()
      current = { header: line, lines: [] }
      continue
    }
    if (!current && SINGLE_YEAR_RE.test(line)) {
      push()
      current = { header: line, lines: [] }
      continue
    }
    if (!current) {
      // 职位段前面常有一行「公司名」，留给后面的标题行组队
      if (!isBullet && line.length <= 80 && !/[。.!?]$/.test(line)) pendingHeader = line
      else if (pendingHeader) pendingHeader = null
      current = { header: pendingHeader ? `${pendingHeader}\n${line}` : line, lines: [] }
      continue
    }
    current.lines.push({ text: line, bullet: isBullet })
  }
  push()
  return blocks.filter((block) => block.header)
}

/** 从标题行里拆出 职位 / 公司 / 时间。 */
export function parseRoleHeader(header) {
  const parts = String(header ?? '').split(/\n/).map(cleanLine).filter(Boolean)
  const joined = parts.join(' | ')
  const periodMatch = DATE_RANGE_RE.exec(joined)
  const period = periodMatch ? `${periodMatch[1]} – ${periodMatch[2]}` : ''
  let rest = joined.replace(DATE_RANGE_RE, '').replace(/[（(]\s*[)）]/g, '').replace(/\s{2,}/g, ' ').trim()
  rest = rest.replace(/^[-–—|·,\s]+|[-–—|·,\s]+$/g, '')
  const pieces = rest
    .split(/\s+(?:at|@|[-–—|·]|\||,)\s+|\s*\|\s*|\s*·\s*/i)
    .map((piece) => piece.trim())
    .filter(Boolean)

  const looksCompany = (value) => /(ltd|limited|inc\.?|llc|corp|corporation|group|company|co\.|bank|technolog|solution|consult|holdings|有限公司|集团|银行|科技)/i.test(value)
  let title = ''
  let company = ''
  if (pieces.length >= 2) {
    if (looksCompany(pieces[0]) && !looksCompany(pieces[1])) {
      company = pieces[0]
      title = pieces[1]
    } else {
      title = pieces[0]
      company = pieces.slice(1).join(' / ')
    }
  } else if (pieces.length === 1) {
    if (looksCompany(pieces[0])) company = pieces[0]
    else title = pieces[0]
  }
  return { title: title.slice(0, 80), company: company.slice(0, 80), period }
}

function findTools(text) {
  const haystack = String(text ?? '')
  const found = []
  for (const term of TOOL_TERMS) {
    const isAscii = /^[\x00-\x7F]+$/.test(term)
    const re = isAscii
      ? new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i')
      : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    if (re.test(haystack)) found.push(term)
  }
  return found
}

function findDomains(text) {
  return DOMAIN_TERMS.filter((entry) => entry.re.test(String(text ?? ''))).map((entry) => entry.label)
}

function hasMetric(text) {
  return METRIC_RE.test(String(text ?? ''))
}

function actionOf(bullet) {
  const first = String(bullet ?? '').trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '')
  return VERBS.has(first) ? first : ''
}

/**
 * 主入口：把简历理解成结构 + 关键词。
 * @returns {{summary, seniority, roles, achievements, keywords, searchKeywords, domains, sections}}
 */
export function understandResume(text, options = {}) {
  const source = String(text ?? '')
  const sections = splitSections(source)
  const skills = options.skills ?? []
  const titles = options.titles ?? []
  const years = options.years ?? null

  const experienceText = sections.experience ?? source
  const roleBlocks = splitRoles(experienceText)

  const roles = roleBlocks.map((block) => {
    const meta = parseRoleHeader(block.header)
    const bullets = block.lines
      .filter((item) => item.text.length >= 8)
      .map((item) => item.text)
    const withMetric = bullets.filter((item) => hasMetric(item))
    const withAction = bullets.filter((item) => actionOf(item))
    const highlights = [...new Set([...withMetric, ...withAction])].slice(0, 3)
    return {
      ...meta,
      highlights: highlights.map((item) => item.slice(0, 220)),
      bullets,
      metrics: withMetric.length,
    }
  })

  const allBullets = roles.flatMap((role) => role.bullets)
  const achievements = [...new Set(allBullets.filter((item) => hasMetric(item)))].slice(0, 6)

  // 领域先看经历/项目/技能；都认不出来才退到简介（简介里常混着教育信息）
  const focusText = [experienceText, sections.projects, sections.skills].filter(Boolean).join('\n')
  const introText = [sections.summary].filter(Boolean).join('\n')
  const DOMAIN_ALIAS = new Map([['data', '数据分析'], ['engineering', '数据工程'], ['finance', '金融']])
  const extraDomains = (options.domains ?? [])
    .map((value) => DOMAIN_ALIAS.get(String(value).toLowerCase()) ?? (/[\u4e00-\u9fff]/.test(String(value)) ? String(value) : ''))
    .filter(Boolean)
  const primaryDomains = findDomains(focusText)
  const domains = [...new Set([...primaryDomains, ...(primaryDomains.length === 0 ? findDomains(introText) : []), ...extraDomains])].slice(0, 3)

  const inferredTitles = TITLE_HINTS.filter((hint) => hint.re.test(focusText)).map((hint) => hint.label).slice(0, 1)
  const effectiveTitles = titles.length > 0 ? titles.map((item) => item.label) : inferredTitles
  // 标题缺失时用词表/兜底命中的职位补位（简历里常见「公司名 | 日期」这种写法）
  if (effectiveTitles.length > 0) {
    for (const role of roles) {
      if (!role.title) role.title = effectiveTitles[0]
    }
  }

  // 关键词：技能（词表）+ 工具（正则表）+ 领域 + 职位，按出现次数与「是否在最近一段经历」加权
  const weights = new Map()
  const bump = (label, kind, count = 1, evidence = '') => {
    if (!label) return
    const key = `${kind}:${label.toLowerCase()}`
    const entry = weights.get(key) ?? { label, kind, count: 0, evidence: '' }
    entry.count += count
    if (!entry.evidence && evidence) entry.evidence = evidence.slice(0, 120)
    weights.set(key, entry)
  }

  for (const skill of skills) bump(skill.label, '技能', Math.max(1, skill.count ?? 1))
  for (const tool of findTools(source)) bump(tool, '工具', 1, allBullets.find((item) => item.toLowerCase().includes(tool.toLowerCase())) ?? '')
  for (const domain of domains) bump(domain, '领域', 2)
  for (const title of titles) bump(title.label, '职位', 2)

  // 最近一段经历里出现过的词更值钱
  const recentText = roles[0]?.bullets?.join(' ') ?? ''
  for (const entry of weights.values()) {
    const inRecent = recentText.toLowerCase().includes(entry.label.toLowerCase())
    if (inRecent) entry.count += 2
  }

  const keywords = [...weights.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 24)
    .map((entry) => ({ label: entry.label, kind: entry.kind, weight: entry.count, evidence: entry.evidence }))

  // 同一个词可能既是「技能」又是「工具」，只留一条（技能优先）
  const kindRank = { 技能: 0, 工具: 1, 职位: 2, 领域: 3 }
  const deduped = []
  for (const entry of keywords) {
    const existing = deduped.find((item) => item.label.toLowerCase() === entry.label.toLowerCase())
    if (!existing) {
      deduped.push(entry)
      continue
    }
    if (kindRank[entry.kind] < kindRank[existing.kind]) {
      existing.kind = entry.kind
    }
    existing.weight = Math.max(existing.weight, entry.weight)
  }
  const finalKeywords = deduped.slice(0, 16)

  const seniority = SENIOR_RE.test(source)
    ? 'senior'
    : JUNIOR_RE.test(source) || (Number.isFinite(years) && years <= 1)
      ? 'junior'
      : Number.isFinite(years) && years >= 5
        ? 'senior'
        : 'mid'

  const roleTitles = roles.map((role) => role.title).filter((value) => value && !/(ltd|limited|公司|集团|银行|有限公司)/i.test(value))
  const topTitles = (effectiveTitles.length > 0 ? effectiveTitles : roleTitles).slice(0, 2)
  const topSkills = skills.slice(0, 3).map((item) => chineseOf(item.label))

  const pieces = []
  if (Number.isFinite(years) && years > 0) pieces.push(`${years} 年经验`)
  if (topTitles.length > 0) pieces.push(`做过 ${topTitles.map((title) => chineseOf(title)).join(' / ')}`)
  if (domains.length > 0) pieces.push(`涉及 ${domains.join('、')}`)
  if (topSkills.length > 0) pieces.push(`核心技能 ${topSkills.join('、')}`)
  if (achievements.length > 0) pieces.push(`有 ${achievements.length} 项量化成果`)
  let summary = pieces.join('，')
  if (summary !== '') summary += '。'

  // 搜索用关键词：职位优先，其次工具类技能，最后才是领域（「电商/零售」这种不适合直接搜）
  const toolSet = new Set(TOOL_TERMS.map((term) => term.toLowerCase()))
  const orderedSkills = [...skills.filter((item) => toolSet.has(item.label.toLowerCase())), ...skills.filter((item) => !toolSet.has(item.label.toLowerCase()))].map((item) => item.label)
  const searchKeywords = []
  for (const value of [...topTitles, ...orderedSkills, ...domains]) {
    const clean = String(value ?? '').trim()
    if (clean !== '' && !searchKeywords.includes(clean)) searchKeywords.push(clean)
    if (searchKeywords.length >= 3) break
  }

  const directionText = [sections.summary, experienceText, sections.projects, sections.skills].filter(Boolean).join('\n')
  const directions = computeDirections(directionText, effectiveTitles, skills.map((item) => item.label))

  return {
    summary,
    seniority,
    directions,
    roles: roles.slice(0, 6),
    achievements,
    keywords: finalKeywords,
    searchKeywords,
    domains,
    sections: Object.fromEntries(Object.keys(sections).map((key) => [key, (sections[key] ?? '').length])),
  }
}
