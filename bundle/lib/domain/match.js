import { EXPERIENCE_RULES, FRESHNESS, TIER_A, TIER_B, TIER_C, WEIGHTS, WEIGHT_KEYS } from '../constants.js'
import { compareExperience } from './experience.js'

export function tierOf(score) {
  if (score >= TIER_A) return 'A'
  if (score >= TIER_B) return 'B'
  if (score >= TIER_C) return 'C'
  return 'X'
}

function tokenize(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter((token) => token.length > 1),
  )
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) {
    if (right.has(token)) shared += 1
  }
  return shared / (left.size + right.size - shared)
}

function containsAny(values, wanted) {
  if (!Array.isArray(wanted) || wanted.length === 0) return true
  const haystack = (values ?? []).map((value) => String(value).toLowerCase())
  return wanted.some((item) => {
    const needle = String(item).toLowerCase()
    return haystack.some((value) => value.includes(needle))
  })
}

export function freshnessOf(listedAt, now = Date.now()) {
  const published = Date.parse(listedAt ?? '')
  if (!Number.isFinite(published)) return 0
  const days = (now - published) / 86400000
  if (days <= 0) return 1
  const bucket = FRESHNESS.find((entry) => days <= entry.maxDays)
  return bucket ? bucket.value : 0
}

/**
 * 权重归一：只认 WEIGHT_KEYS 里的键，非负、夹到 0-100（允许传百分比），最后除以总和。
 * 用户把某一项拉到 0 也算合法（等于不要这项）。
 */
export function normalizeWeights(input) {
  if (!input || typeof input !== 'object') return { ...WEIGHTS }
  const picked = {}
  for (const key of WEIGHT_KEYS) {
    const value = Number(input[key])
    picked[key] = Number.isFinite(value) && value >= 0 ? Math.min(100, value) : WEIGHTS[key]
  }
  const sum = Object.values(picked).reduce((total, value) => total + value, 0)
  if (!(sum > 0)) return { ...WEIGHTS }
  for (const key of WEIGHT_KEYS) picked[key] = picked[key] / sum
  return picked
}

export function normalizeRules(input) {
  const penalty = Number(input?.penalty)
  return {
    ...EXPERIENCE_RULES,
    penalty: Number.isFinite(penalty) ? Math.min(1, Math.max(0.05, penalty)) : EXPERIENCE_RULES.penalty,
  }
}

/**
 * 单条打分：七项加权到 100，经验不足再乘门槛系数整体降分。
 */
export function scoreJob(profile, job, prefs = {}, now = Date.now(), weights = WEIGHTS, rules = EXPERIENCE_RULES) {
  const haystack = [job.title, job.teaser, job.contentText]
    .filter((value) => typeof value === 'string' && value !== '')
    .join(' ')
    .toLowerCase()

  const skills = Array.isArray(profile.skills) ? profile.skills : []
  const hits = skills.filter((skill) => haystack.includes(String(skill).toLowerCase())).length
  const skillHit = Math.min(1, hits / Math.max(1, Math.min(skills.length, 5)))

  const titleHit = jaccard(tokenize(job.title), tokenize((profile.titles ?? []).join(' ')))

  const domains = Array.isArray(profile.domains) ? profile.domains : []
  const domainHit = domains.length > 0 && containsAny(job.classifications, domains) ? 1 : 0

  const locationHit = containsAny(job.locations, prefs.locations) ? 1 : 0

  const wantedWorkTypes = Array.isArray(prefs.workTypes) ? prefs.workTypes : []
  const workTypeHit =
    wantedWorkTypes.length === 0
      ? 1
      : (job.workTypes ?? []).some((item) =>
          wantedWorkTypes.some((wanted) => String(item).toLowerCase() === String(wanted).toLowerCase()),
        )
        ? 1
        : 0

  const comparison = compareExperience(profile.years, job.experience)
  const experienceHit = comparison.verdict === 'meet' ? rules.meet : comparison.verdict === 'short' ? rules.short : rules.unknown

  const factors = {
    skills: skillHit,
    title: titleHit,
    domain: domainHit,
    location: locationHit,
    workType: workTypeHit,
    freshness: freshnessOf(job.listedAt, now),
    experience: experienceHit,
  }

  const weighted = WEIGHT_KEYS.reduce((sum, key) => sum + (weights[key] ?? 0) * (factors[key] ?? 0), 0)
  const gateApplied = comparison.verdict === 'short'
  const score = Math.round(100 * weighted * (gateApplied ? rules.penalty : 1))
  return { score, tier: tierOf(score), factors, experience: comparison, gateApplied }
}

/**
 * 硬筛：过期、地点、工作类型。
 * 和打分解耦，没简历画像时也要生效（否则用户选了地点/类型却什么都没发生）。
 */
export function filterJobs(jobs, prefs = {}, now = Date.now()) {
  const dropped = { expired: 0, location: 0, workType: 0 }
  const kept = []
  for (const job of jobs ?? []) {
    if (job.isExpired === true) {
      dropped.expired += 1
      continue
    }
    const expiresAt = Date.parse(job.expiresAt ?? '')
    if (Number.isFinite(expiresAt) && expiresAt < now) {
      dropped.expired += 1
      continue
    }
    if (!containsAny(job.locations, prefs.locations)) {
      dropped.location += 1
      continue
    }
    const wantedWorkTypes = Array.isArray(prefs.workTypes) ? prefs.workTypes : []
    if (
      wantedWorkTypes.length > 0 &&
      !(job.workTypes ?? []).some((item) =>
        wantedWorkTypes.some((wanted) => String(item).toLowerCase() === String(wanted).toLowerCase()),
      )
    ) {
      dropped.workType += 1
      continue
    }
    kept.push(job)
  }
  return { jobs: kept, dropped }
}

/**
 * 整批匹配：先硬筛，再打分排序，最后按档位计数。
 */
export function matchJobs(profile, jobs, prefs = {}, now = Date.now(), config = {}) {
  const weights = normalizeWeights(config.weights)
  const rules = normalizeRules(config.rules)
  const { jobs: filtered, dropped } = filterJobs(jobs, prefs, now)
  const kept = []

  for (const job of filtered) {
    // scoreJob 的 experience 是「你和要求比」的结果（haveYears/verdict/gapYears），
    // 直接展开会把原来的 minYears / industry / phrase 盖掉，所以这里合并而不是覆盖。
    const scored = scoreJob(profile, job, prefs, now, weights, rules)
    kept.push({ ...job, ...scored, experience: { ...(job.experience ?? {}), ...(scored.experience ?? {}) } })
  }

  kept.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return Date.parse(right.listedAt ?? '') - Date.parse(left.listedAt ?? '')
  })

  const counts = { A: 0, B: 0, C: 0, X: 0 }
  for (const job of kept) counts[job.tier] += 1

  return { jobs: kept, counts, dropped, weights, rules }
}
