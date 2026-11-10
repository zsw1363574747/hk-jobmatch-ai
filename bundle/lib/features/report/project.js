import { normalizeSalary, salaryShort } from '../../domain/salary.js'

const TIERS = ['A', 'B', 'C', 'X']

function findVerdict(verdicts, id) {
  if (!Array.isArray(verdicts)) return null
  return verdicts.find((verdict) => String(verdict.id) === String(id)) ?? null
}

/**
 * run → 页面 DTO（纯函数）。
 *
 * 规则：
 * - 不改 run、不排序 run、不写文件；
 * - salary 永远是对象或 null；
 * - 前端只读这份投影，不自己猜字段类型。
 */
export function projectRun(run, verdicts = []) {
  const jobs = (run.jobs ?? []).map((job) => {
    const key = String(job.key ?? `jobsdb:${job.id}`)
    const detail = run.details?.[key] ?? run.details?.[job.id] ?? {}
    const verdict = findVerdict(verdicts, key) ?? findVerdict(verdicts, job.id)
    const salary = normalizeSalary(job.salary) ?? normalizeSalary(job.salaryLabel)
    const location =
      (Array.isArray(job.locations) && job.locations[0]) ||
      job.location ||
      detail.location ||
      ''

    const projected = {
      id: job.id,
      key,
      source: job.source ?? 'jobsdb',
      sourceLabel: job.sourceLabel ?? '',
      title: job.title,
      company: job.company ?? '',
      url: job.url,
      locations: job.locations ?? [],
      workTypes: job.workTypes ?? [],
      classifications: job.classifications ?? [],
      listedAt: job.listedAt ?? '',
      teaser: job.teaser ?? '',
      salaryLabel: job.salaryLabel ?? '',
      salary,
      salaryText: salary ? salaryShort(salary) : '',
      contentText: detail.contentText ?? job.contentText ?? '',
      contentChars: detail.contentChars ?? job.contentChars ?? 0,
      jdSource: job.jdSource ?? detail.source ?? '',
      experience: job.experience ?? null,
      location,
      companyProfile: job.companyProfile ?? detail.companyProfile ?? null,
      expiresAt: detail.expiresAt ?? job.expiresAt ?? '',
      score: job.score ?? null,
      tier: job.tier ?? null,
      factors: job.factors ?? null,
      verdict: verdict ?? null,
    }

    if (verdict) {
      projected.score = verdict.fit
      projected.tier = verdict.tier
    }
    return projected
  })

  jobs.sort((left, right) => (right.score ?? -1) - (left.score ?? -1))

  const counts = { A: 0, B: 0, C: 0, X: 0 }
  for (const job of jobs) {
    if (job.tier && TIERS.includes(job.tier)) counts[job.tier] += 1
  }

  return {
    schemaVersion: 3,
    runId: run.runId,
    createdAt: run.createdAt,
    query: run.query ?? null,
    profileSummary: run.profileSummary ?? null,
    weights: run.weights ?? null,
    rules: run.rules ?? null,
    jobs,
    counts,
  }
}
