/**
 * 工作经验抽取（初版）：从 JD 正文 / 搜索摘要里读「雇主要求多少年」，
 * 并和简历画像的 years 比对，给出 达标 / 不足 / 未知。
 *
 * 纯规则、零依赖；宁可返回 unknown，也不猜。
 */

export const EXPERIENCE_SOURCE_LABEL = Object.freeze({
  jd: 'JD 正文',
  'search-api': '搜索摘要',
  teaser: '搜索摘要',
  manual: '手动粘贴',
  cache: '缓存',
  none: '未提及',
})

const RANGE = /(\d{1,2})\s*(?:-|–|—|~|to|至|到)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?|年)/gi
const AT_LEAST = /(?:at\s+least|minimum(?:\s+of)?|min\.?|more\s+than|over|above|至少|不少于|不低于)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?|年)/gi
const PLUS = /(\d{1,2})\s*\+\s*(?:years?|yrs?|年)/gi
const PLAIN = /(\d{1,2})\s*\+?\s*(?:years?|yrs?|年)/gi

const CN_NUM = '[一二三四五六七八九十两]{1,3}'
// 中文写法比英文松散：「至少三年 IT/产品/项目管理工作经验」中间隔着一串名词
const CN_AT_LEAST = new RegExp(`(?:至少|不少于|不低於|不低于|最少)\\s*(${CN_NUM})\\s*年`, 'g')
const CN_PLUS = new RegExp(`(${CN_NUM})\\s*年(?:或)?以上`, 'g')
const CN_PLAIN = new RegExp(`(${CN_NUM})\\s*年(?:以上|或以上)?[^。\\n]{0,12}?(?:工作)?(?:经验|經驗|经历|經歷)`, 'g')

// 英文也会把数字写成单词："Minimum three years working experience"
const EN_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
})
const EN_NUM = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)'
const EN_AT_LEAST = new RegExp(`(?:at\\s+least|minimum(?:\\s+of)?|min\\.?|more\\s+than|over|above)\\s+(${EN_NUM})\\s+(?:years?|yrs?)\\b`, 'gi')
const EN_PLAIN = new RegExp(`\\b(${EN_NUM})\\s+(?:years?|yrs?)\\b`, 'gi')

const CN_DIGITS = Object.freeze({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 })

function cnNumber(text) {
  const value = String(text ?? '')
  if (value.length === 0) return null
  if (value.length === 1) return CN_DIGITS[value] ?? null
  if (value.startsWith('十')) return 10 + (CN_DIGITS[value[1]] ?? 0)
  if (value.includes('十')) {
    const [tens, ones] = value.split('十')
    const high = CN_DIGITS[tens] ?? 0
    return high * 10 + (ones ? CN_DIGITS[ones] ?? 0 : 0)
  }
  return null
}

const FRESH = /(fresh\s*grad|entry[\s-]?level|no\s+(?:prior\s+)?experience\s+(?:required|needed)|应届|无经验要求)/i

/**
 * 行业词表：只说「几年」不够——雇主通常还会写「几年**哪一行**的经验」。
 * 顺序有意义：先具体（银行/保险）后宽泛（金融），避免 "financial reporting" 抢走 "banking"。
 * 每条都能同时匹配中英文，label 是给界面看的中文短名。
 */
export const SECTORS = Object.freeze([
  { id: 'banking', label: '银行', re: /(?:retail\s*bank|corporate\s*bank|investment\s*bank|banking|bank\b|銀行|银行)/i },
  { id: 'insurance', label: '保险', re: /(?:insurance|underwriting|actuar\w*|保險|保险)/i },
  { id: 'securities', label: '证券/资管', re: /(?:securities|brokerage|asset\s+management|fund\s+management|wealth\s+management|證券|证券|資產管理|资产管理)/i },
  { id: 'fintech', label: '金融科技', re: /(?:fintech|payment\s+(?:industry|sector)|virtual\s+bank|金融科技|支付)/i },
  { id: 'finance', label: '金融', re: /(?:financial\s+services|financial\s+industry|finance\s+(?:industry|sector)|金融)/i },
  { id: 'accounting', label: '会计/审计', re: /(?:accounting|audit(?:ing)?|tax\s+(?:firm|practice)|會計|会计|審計|审计)/i },
  { id: 'it', label: 'IT/科技', re: /(?:information\s*(?:&|and)?\s*communication\s*technology|ict\b|information\s+technology|it\s*[/、]|it\s+(?:industry|sector)|software|saas|internet|technology\s+(?:company|industry|sector)|tech\s+(?:company|industry)|資訊科技|资讯科技|互联网|互聯網|科技)/i },
  { id: 'telecom', label: '电信', re: /(?:telecom\w*|mobile\s+network|電訊|电讯|电信)/i },
  { id: 'retail', label: '零售/电商', re: /(?:retail|e-?commerce|consumer\s+goods|零售|電商|电商)/i },
  { id: 'fnb', label: '餐饮/酒店', re: /(?:f\s*&\s*b|food\s*(?:&|and)\s*beverage|restaurant|hotel|hospitality|catering|餐飲|餐饮|酒店|旅遊|旅游)/i },
  { id: 'logistics', label: '物流/供应链', re: /(?:logistics|supply\s+chain|warehous\w*|freight|shipping|forwarder|物流|供應鏈|供应链|貨運|货运)/i },
  { id: 'trading', label: '贸易', re: /(?:trading\s+(?:company|firm|industry)|import\s*(?:&|and)\s*export|import\/export|貿易|贸易|進出口|进出口)/i },
  { id: 'manufacturing', label: '制造', re: /(?:manufactur\w*|factory|industrial\s+(?:sector|industry)|製造|制造|工廠|工厂)/i },
  { id: 'property', label: '地产/建筑', re: /(?:property|real\s+estate|construction|property\s+management|地產|地产|物業|物业|建築|建筑)/i },
  { id: 'healthcare', label: '医疗/医药', re: /(?:healthcare|health\s+care|medical|pharma\w*|hospital|clinic|醫療|医疗|醫藥|医药|醫院|医院)/i },
  { id: 'education', label: '教育/培训', re: /(?:education|training\s+(?:industry|sector|institution)|school|university|tutor|教育|培訓|培训)/i },
  { id: 'media', label: '媒体/广告', re: /(?:media|advertising|marketing\s*(?:&|and)?\s*communications|marketing\s+agency|publishing|廣告|广告|媒體|媒体)/i },
  { id: 'legal', label: '法律', re: /(?:law\s+firm|legal\s+(?:industry|sector|practice|services|experience)|律師|律师|法律)/i, exact: ['legal'] },
  { id: 'hr', label: '人力资源', re: /(?:human\s+resources|recruitment\s+(?:industry|firm)|人力資源|人力资源)/i },
  { id: 'ngo', label: '社福/NGO', re: /(?:ngo|non-?profit|charity|social\s+services|community\s+services|社福|非牟利|非营利)/i },
  { id: 'government', label: '政府/公营', re: /(?:government|public\s+sector|civil\s+service|政府|公營|公营)/i },
  { id: 'business-services', label: '商业服务', re: /(?:business\s+services|professional\s+services|consulting\s+(?:firm|industry|services)|顧問|顾问)/i },
  { id: 'sales', label: '销售', re: /(?:sales\s+(?:industry|experience)|business\s+development|銷售|销售)/i },
  { id: 'customer-service', label: '客服', re: /(?:customer\s+service|call\s+centre|call\s+center|客服|客戶服務|客户服务)/i },
  { id: 'engineering', label: '工程', re: /(?:engineering\s+(?:industry|sector|field|consultancy)|工程)/i, exact: ['engineering'] },
])

/** 在给定文本里找行业；先命中先返回（词表已按具体度排序）。 */
export function detectSector(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return null
  const normalized = source.trim().toLowerCase().replace(/\s+/g, ' ')
  for (const sector of SECTORS) {
    // 分类名常常就是一个词（"Legal" / "Engineering"），精确匹配优先，避免 JD 里
    // "data engineering" 这种职能词被当成行业。
    if (Array.isArray(sector.exact) && sector.exact.includes(normalized)) {
      return { id: sector.id, label: sector.label, phrase: source.trim() }
    }
  }
  // 大写的 "IT" 单独出现（IT Business Analyst / IT industry）算 IT；小写 it 是代词，不能碰。
  if (/(?:^|[\s(（])IT(?:$|[\s)）,，、])/.test(source)) {
    return { id: 'it', label: 'IT/科技', phrase: 'IT' }
  }
  for (const sector of SECTORS) {
    const match = source.match(sector.re)
    if (match) return { id: sector.id, label: sector.label, phrase: match[0].trim() }
  }
  return null
}

/**
 * 从「几年」那句话的邻域里判断是哪个行业：
 * 先看年份之后（"3 years of experience in banking" 是主流写法），
 * 再看前后文（"banking experience of 3 years"）。
 */
function industryAround(source, index) {
  const after = source.slice(index, Math.min(source.length, index + 120))
  const around = `${source.slice(Math.max(0, index - 100), index)} ${after}`
  const hit = detectSector(after) ?? detectSector(around)
  return hit ? { ...hit, source: 'jd' } : null
}

/** 岗位分类 / 雇主行业字段也能当兜底（JobsDB 的 classifications、政府站的 Industry）。 */
function industryFromLabels(labels) {
  const list = (Array.isArray(labels) ? labels : [labels]).filter((item) => typeof item === 'string' && item.trim() !== '')
  for (const label of list) {
    const hit = detectSector(label)
    if (hit) return { ...hit, phrase: label.trim(), source: 'classification' }
  }
  // 分类名多半是「职能」而不是「行业」（Business/Systems Analysts、Market Research…），
  // 词表认不出来就不硬套，宁可显示「行业未提及」。
  return null
}

function sane(value) {
  return Number.isInteger(value) && value >= 0 && value <= 30
}

function pack(source, match, minYears, maxYears, requiredYears, phrase) {
  const index = typeof match?.index === 'number' ? match.index : source.indexOf(phrase)
  return {
    minYears,
    maxYears,
    requiredYears,
    phrase,
    industry: index >= 0 ? industryAround(source, index) : null,
  }
}

/**
 * @param {string} text
 * @returns {{minYears:number|null, maxYears:number|null, requiredYears:number|null, phrase:string, industry:object|null}}
 */
export function parseExperience(text) {
  const source = String(text ?? '')
  const empty = { minYears: null, maxYears: null, requiredYears: null, phrase: '', industry: null }
  if (source.trim() === '') return empty

  // 1. 区间优先：3-5 years / 3 至 5 年
  for (const match of source.matchAll(RANGE)) {
    const low = Number(match[1])
    const high = Number(match[2])
    if (sane(low) && sane(high) && high >= low) {
      return pack(source, match, low, high, high, match[0].trim())
    }
  }

  // 2. at least / minimum 3 years
  for (const match of source.matchAll(AT_LEAST)) {
    const value = Number(match[1])
    if (sane(value)) return pack(source, match, value, null, value, match[0].trim())
  }
  for (const match of source.matchAll(EN_AT_LEAST)) {
    const value = EN_WORDS[String(match[1]).toLowerCase()]
    if (sane(value)) return pack(source, match, value, null, value, match[0].trim())
  }

  // 3. 3+ years
  for (const match of source.matchAll(PLUS)) {
    const value = Number(match[1])
    if (sane(value)) return pack(source, match, value, null, value, match[0].trim())
  }

  // 4. 裸写 3 years / 3 年（取最大值，避免 "1 year contract, 3 years experience" 取到 1）
  let best = null
  for (const match of source.matchAll(PLAIN)) {
    const value = Number(match[1])
    if (!sane(value) || value === 0) continue
    if (!best || value > best.value) best = { value, match }
  }
  if (best) return pack(source, best.match, best.value, null, best.value, best.match[0].trim())

  // 4b. 英文数字单词：Minimum three years / three years working experience
  for (const match of source.matchAll(EN_PLAIN)) {
    const value = EN_WORDS[String(match[1]).toLowerCase()]
    if (!sane(value) || value === 0) continue
    if (!best || value > best.value) best = { value, match }
  }
  if (best) return pack(source, best.match, best.value, null, best.value, best.match[0].trim())

  // 5. 中文数字：至少三年 / 三年以上 / 三年工作经验（中间可能夹着行业词）
  for (const match of source.matchAll(CN_AT_LEAST)) {
    const value = cnNumber(match[1])
    if (sane(value) && value > 0) return pack(source, match, value, null, value, match[0].trim())
  }
  for (const match of source.matchAll(CN_PLUS)) {
    const value = cnNumber(match[1])
    if (sane(value) && value > 0) return pack(source, match, value, null, value, match[0].trim())
  }
  for (const match of source.matchAll(CN_PLAIN)) {
    const value = cnNumber(match[1])
    if (sane(value) && value > 0) {
      return pack(source, match, value, null, value, match[0].trim())
    }
  }

  // 6. 明说应届 / 无经验要求
  if (FRESH.test(source)) return { minYears: 0, maxYears: 0, requiredYears: 0, phrase: '无经验要求', industry: null }

  return empty
}

/** 有些 JD（政府站、部分雇主）单列一行 "Industry: Import and Export Trades"。 */
function employerIndustry(text) {
  const match = String(text ?? '').match(/(?:^|\n)\s*(?:Industry|行業|行业)\s*[:：]\s*\n?\s*([^\n]{2,60})/i)
  if (!match) return null
  const value = match[1].trim()
  if (value === '' || value === '-') return null
  const hit = detectSector(value)
  return { ...(hit ?? { id: 'other', label: value.length > 14 ? `${value.slice(0, 14)}…` : value }), phrase: value, source: 'employer' }
}

/**
 * 一条岗位的「雇主经验要求」：JD 优先，退到搜索摘要；都没有就是 unknown。
 * 行业标签优先级：年份那句话的上下文 → JD 里的 Industry 行 → 岗位分类。
 * @param {{contentText?:string, teaser?:string, source?:string, classifications?:string[], industryLabel?:string}} input
 */
export function buildExperience(input = {}) {
  const contentText = typeof input.contentText === 'string' ? input.contentText : ''
  const teaser = typeof input.teaser === 'string' ? input.teaser : ''
  const classifications = input.classifications ?? []

  const titleIndustry = () => {
    if (!input.title) return null
    const hit = industryFromLabels([input.title])
    return hit ? { ...hit, source: 'title' } : null
  }

  const fallbackIndustry = () =>
    industryFromLabels(classifications) ??
    (input.industryLabel ? industryFromLabels([input.industryLabel]) : null) ??
    employerIndustry(contentText) ??
    // 标题里常直接写行业：Data Analyst (Banking)、IT Business Analyst
    titleIndustry()

  if (contentText.length > 40) {
    const fromJd = parseExperience(contentText)
    if (fromJd.requiredYears !== null) {
      const industry = fromJd.industry ?? employerIndustry(contentText) ?? industryFromLabels(classifications) ?? (input.industryLabel ? industryFromLabels([input.industryLabel]) : null) ?? titleIndustry()
      return { ...fromJd, industry, source: input.source && input.source !== 'jd' ? input.source : 'jd', known: true }
    }
  }
  if (teaser.length > 0) {
    const fromTeaser = parseExperience(teaser)
    if (fromTeaser.requiredYears !== null) {
      return { ...fromTeaser, industry: fromTeaser.industry ?? fallbackIndustry(), source: 'teaser', known: true }
    }
  }
  return { minYears: null, maxYears: null, requiredYears: null, phrase: '', industry: null, source: 'none', known: false }
}

/**
 * 简历经验 vs 岗位要求。
 * @returns {{haveYears:number|null, requiredYears:number|null, verdict:'meet'|'short'|'unknown', gapYears:number|null}}
 */
export function compareExperience(haveYears, experience) {
  const have = Number.isInteger(haveYears) && haveYears >= 0 ? haveYears : null
  const required = experience && Number.isInteger(experience.requiredYears) ? experience.requiredYears : null
  if (have === null || required === null) {
    return { haveYears: have, requiredYears: required, verdict: 'unknown', gapYears: null }
  }
  const gap = have - required
  return { haveYears: have, requiredYears: required, verdict: gap >= 0 ? 'meet' : 'short', gapYears: gap }
}

/** 列表里显示的一行字：3-5 年 · 银行 / 3 年+ / 未提及 */
export function formatExperience(experience) {
  if (!experience || experience.requiredYears === null || experience.requiredYears === undefined) return '未提及'
  const { minYears, maxYears } = experience
  const range =
    Number.isInteger(minYears) && Number.isInteger(maxYears) && maxYears !== minYears
      ? `${minYears}-${maxYears} 年`
      : `${experience.requiredYears} 年+`
  const industry = experience.industry?.label ? ` · ${experience.industry.label}` : ''
  return `${range}${industry}`
}
