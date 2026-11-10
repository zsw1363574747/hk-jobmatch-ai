/**
 * 薪资解析与归一（P0）。
 *
 * 口径：只报 base 月薪。双薪 / 花红 / 13 薪单独挂在 bonus 上，不折进数字——
 * 否则和别的岗位比的时候口径就乱了。
 *
 * 实测见过的写法（都要吃得下）：
 *   $28,000 – $35,000 per month     $45k - $55k p.m.        30k-40k/month
 *   HK$18,000 monthly               $6,000 - $6,500 per month
 *   $25,000 - $30,000 per month, with Double Pay and Medical Insurance
 *   $42k - $55k p.a.                Competitive package / NA / Negotiable / 面议  → 没有
 */
import { decodeEntities } from '../text.js'

export const SALARY_MONTHLY_FLOOR = 3000
export const SALARY_MONTHLY_CEIL = 600000

const PERIOD_RULES = [
  { period: 'month', re: /(?:per\s*month|monthly|\/\s*month|p\.?\s?m\.?|per\s*mth|月薪|每月)/i },
  { period: 'year', re: /(?:per\s*annum|per\s*year|annually|yearly|p\.?\s?a\.?|\/\s*year|年薪|每年)/i },
  { period: 'day', re: /(?:per\s*day|daily|\/\s*day|日薪)/i },
  { period: 'hour', re: /(?:per\s*hour|hourly|\/\s*hour|時薪|时薪)/i },
]

const BONUS_RE = /(\d{1,2}\s*th\s*month|double\s*pay|triple\s*pay|13th|14th|discretionary\s*bonus|performance\s*bonus|year-?end\s*bonus|花红|花紅|年終獎|年终奖|雙糧|双粮|十三薪|十四薪|佣金|commission)/i

const NO_SALARY_RE = /^(?:n\/?a|na|none|nil|negotiable|competitive(?:\s*package)?|to\s*be\s*negotiated|tbn|面议|面議|待定|按經驗|按经验)[\s.]*$/i

function inferCurrency(text) {
  if (/(?:rmb|cny|¥|人民幣|人民币)/i.test(text)) return 'CNY'
  if (/(?:us\$|usd)/i.test(text)) return 'USD'
  if (/(?:hk\$|hkd)/i.test(text)) return 'HKD'
  return 'HKD'
}

function periodOf(text) {
  for (const rule of PERIOD_RULES) {
    if (rule.re.test(text)) return rule.period
  }
  return null
}

/** 从一段文字里抠出金额数字（支持 28,000 / 28k / 3萬）。 */
function numbersIn(text) {
  const out = []
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k|萬|万)?/gi
  let match
  while ((match = re.exec(text)) !== null) {
    const raw = Number(String(match[1]).replace(/,/g, ''))
    if (!Number.isFinite(raw)) continue
    let value = raw
    if (match[2] === 'k' || match[2] === 'K') value = raw * 1000
    if (match[2] === '萬' || match[2] === '万') value = raw * 10000
    // 年份、百分比、人数之类的噪声
    if (value < 1000 || value > 5_000_000) continue
    out.push(Math.round(value))
  }
  return out
}

/**
 * 解析一行薪资文案。解析不出就返回 null（不猜）。
 * @returns {{min:number|null,max:number|null,mid:number,period:string,currency:string,bonus:string,label:string}|null}
 */
export function parseSalaryLabel(label) {
  const text = decodeEntities(String(label ?? '')).replace(/\s+/g, ' ').trim()
  if (text === '') return null
  if (NO_SALARY_RE.test(text)) return null
  if (/^[-\u2013\u2014]+$/.test(text)) return null

  const period = periodOf(text) ?? 'month'
  const nums = numbersIn(text)
  if (nums.length === 0) return null

  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const bonus = (text.match(BONUS_RE) ?? [])[0] ?? ''

  // 明显不是月薪量级的（比如年薪 480,000）按周期判断；周期判断失败就信文案
  return {
    min: min === max ? min : min,
    max: max,
    mid: Math.round((min + max) / 2),
    period,
    currency: inferCurrency(text),
    bonus,
    label: text,
  }
}

/** 统一折算成「月」：只有 month 和 year 能折，日/时薪原样保留但不进比较。 */
export function toMonthly(salary) {
  if (!salary) return null
  if (salary.period === 'month') return { min: salary.min, max: salary.max, mid: salary.mid }
  if (salary.period === 'year') {
    return {
      min: salary.min == null ? null : Math.round(salary.min / 12),
      max: salary.max == null ? null : Math.round(salary.max / 12),
      mid: Math.round(salary.mid / 12),
    }
  }
  return null
}

/** 越界保护：解析出来的数字明显不像月薪就别显示。 */
export function isSaneMonthly(monthly) {
  if (!monthly) return false
  return monthly.mid >= SALARY_MONTHLY_FLOOR && monthly.mid <= SALARY_MONTHLY_CEIL
}

/**
 * 展示用文本。
 *   28–35K / 25K / 60K+ / ≈25–40K（探针）/ ≈29–36K（推断）
 */
export function formatSalary(salary, options = {}) {
  if (!salary) return ''
  const monthly = toMonthly(salary)
  if (!monthly) {
    return salary.label || ''
  }
  const k = (value) => (value == null ? null : Math.round(value / 100) / 10)
  const low = k(monthly.min)
  const high = k(monthly.max)
  const prefix = options.approx ? '≈' : ''
  if (low == null && high == null) return ''
  if (options.openEnded) return `${prefix}${high == null ? low : high}K+`
  if (low != null && high != null && low !== high) return `${prefix}${low}–${high}K`
  return `${prefix}${high == null ? low : high}K`
}

/** 从岗位对象里取一个「最可信」的薪资（明码优先）。 */
export function salaryOfJob(job) {
  if (!job) return null
  if (job.salary?.kind === 'explicit') return job.salary
  const parsed = parseSalaryLabel(job.salaryLabel) ?? parseSalaryLabel(job.salary)
  if (!parsed) return null
  const monthly = toMonthly(parsed)
  if (!isSaneMonthly(monthly)) return null
  return { ...parsed, kind: 'explicit', confidence: 'A', source: 'jd-field' }
}

/** 列表用的短文本：28–35K / ≈25–40K / 60K+ / 未披露。 */
export function salaryShort(salary) {
  if (!salary) return ''
  const approx = salary.kind !== 'explicit'
  const text = formatSalary(salary, { approx, openEnded: Boolean(salary.openEnded) })
  return text
}

/**
 * 把任意历史格式归一成唯一形状：
 *   null | { kind: 'explicit' | 'probed', min, max, mid, period, currency, ... }
 *
 * 旧版 latest.json 里 salary 有时是字符串（detail.salary），
 * 这里统一收口，避免 report / UI 各自判断类型。
 */
export function normalizeSalary(value) {
  if (!value) return null
  if (typeof value === 'string') {
    const parsed = parseSalaryLabel(value)
    if (!parsed) return null
    const monthly = toMonthly(parsed)
    if (!isSaneMonthly(monthly)) return null
    return { ...parsed, ...monthly, kind: 'explicit', confidence: 'A', source: 'jd-field' }
  }
  if (typeof value !== 'object') return null
  const monthly = toMonthly(value)
  const mid = monthly?.mid ?? monthly?.min ?? monthly?.max
  if (mid == null || mid < SALARY_MONTHLY_FLOOR || mid > SALARY_MONTHLY_CEIL) return null
  return {
    ...value,
    ...monthly,
    mid: value.mid ?? monthly.mid ?? mid,
    kind: value.kind === 'probed' || value.kind === 'inferred' ? value.kind : 'explicit',
  }
}

/** 把一条薪资压成一行短文本，给列表/详情用。 */
export function salaryLine(salary) {
  if (!salary) return ''
  const monthly = toMonthly(salary)
  const amount = formatSalary(salary, { approx: salary.kind !== 'explicit', openEnded: salary.openEnded })
  if (!amount) return salary.label ?? ''
  const bonus = salary.bonus ? ` + ${salary.bonus}` : ''
  const period = salary.period && salary.period !== 'month' ? `（${salary.period === 'year' ? '年薪' : salary.period === 'day' ? '日薪' : '时薪'}）` : ''
  const sourceTag =
    salary.source === 'platform-filter'
      ? ' · 平台筛选'
      : salary.source === 'benchmark'
        ? ' · 推断'
        : salary.source === 'cross-platform'
          ? ' · 跨平台'
          : ''
  return `${amount}${period}${bonus}${sourceTag}`
}
