import { buildExperience } from './experience.js'
import { normalizeSalary, salaryShort, toMonthly, parseSalaryLabel } from './salary.js'

/** 跨站唯一键：同一个数字 id 在两家站上可能撞车，所以用 source:nativeId。 */
export function jobKey(job) {
  if (!job) return ''
  return String(job.key ?? `${job.source ?? 'jobsdb'}:${job.id}`)
}

export function findJob(run, ref) {
  const key = String(ref ?? '')
  if (key === '') return null
  return (
    (run.jobs ?? []).find((item) => String(item.key ?? '') === key) ??
    (run.jobs ?? []).find((item) => String(item.key ?? `jobsdb:${item.id}`) === key) ??
    (run.jobs ?? []).find((item) => String(item.id) === key) ??
    null
  )
}

export function findDetail(run, ref) {
  const details = run?.details ?? {}
  const key = String(ref ?? '')
  if (key === '') return null
  if (details[key]) return details[key]
  const hit = Object.keys(details).find((entry) => entry === key || entry.split(':').pop() === key)
  return hit ? details[hit] : null
}

/**
 * 把一个来源详情合并进 job。这是「详情」feature 的唯一写入口：
 * 只更新正文 / 经验 / 薪资字段，不改分数、不排序。
 */
export function applyDetailToJob(job, detail) {
  if (!job || !detail) return job
  const text = typeof detail.contentText === 'string' ? detail.contentText : ''
  job.contentText = text
  job.contentChars = text.length
  job.jdSource = detail.source ?? 'unknown'
  job.experience = buildExperience({
    contentText: text,
    teaser: job.teaser,
    source: detail.source,
    classifications: job.classifications,
    title: job.title,
  })
  if (detail.location) job.location = detail.location
  if (detail.companyProfile) job.companyProfile = detail.companyProfile

  if (detail.salary) {
    const salary = normalizeSalary(detail.salary)
    if (salary) job.salary = salary
    else {
      const parsed = parseSalaryLabel(detail.salary)
      const monthly = toMonthly(parsed)
      if (parsed && monthly) job.salary = { ...parsed, ...monthly, kind: 'explicit', confidence: 'A', source: 'jd-field' }
    }
  }
  job.salaryText = salaryShort(job.salary)
  return job
}

/** 搜索阶段把来源返回的裸 job 补成统一形状。 */
export function normalizeJob(job) {
  if (!job) return job
  const normalized = { ...job, key: jobKey(job) }
  normalized.salary = normalizeSalary(normalized.salary) ?? normalizeSalary(normalized.salaryLabel)
  normalized.salaryText = salaryShort(normalized.salary)
  if (!normalized.experience) {
    normalized.experience = buildExperience({
      teaser: normalized.teaser,
      classifications: normalized.classifications,
      title: normalized.title,
    })
  }
  return normalized
}
