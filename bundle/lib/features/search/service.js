import { MAX_PAGES, PAGE_SIZE, REQUEST_GAP_MS } from '../../constants.js'
import { fail } from '../../errors.js'
import { filterJobs, matchJobs, normalizeRules, normalizeWeights } from '../../domain/match.js'
import { buildExperience } from '../../domain/experience.js'
import { salaryOfJob, salaryShort } from '../../domain/salary.js'
import { normalizeJob } from '../../domain/job.js'
import { createRunId } from '../../domain/run.js'
import { normalizeProfile } from '../../domain/profile.js'
import { DEFAULT_SOURCES, normalizeSourceIds, searchAll } from '../../sources/index.js'
import { writeRun } from '../../storage/run-store.js'
import { writePage } from '../../storage/page-store.js'
import { projectRun } from '../report/project.js'

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function normalizeKeywords(value) {
  const list = Array.isArray(value) ? value : [value]
  return list
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 搜索命令：关键词 → 多站 → 去重 → 打分 → run → page。
 * 只负责搜索，不碰详情补全、薪资探针、翻译、新闻。
 */
export async function search(input = {}, options = {}) {
  const keywords = normalizeKeywords(input.keywords)
  if (keywords.length === 0) {
    throw Object.assign(fail('E_NO_KEYWORDS'), { step: 'search' })
  }

  const maxPages = Math.min(MAX_PAGES, Math.max(1, Number(input.maxPages) || 1))
  // 发布时间窗口只用于前端标红，不在这里过滤：超过窗口的岗位仍然保留。
  const postedWithinWeeks = Math.min(52, Math.max(1, Math.round(Number(input.postedWithinWeeks) || 4)))
  const sourceIds = normalizeSourceIds(input.sources ?? DEFAULT_SOURCES)
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now()

  const aggregate = await searchAll(
    {
      keywords,
      sources: sourceIds,
      maxPages,
      perSource: input.perSource,
      detailLimit: input.detailLimit,
    },
    { fetchImpl: options.fetchImpl, sleep, gapMs: REQUEST_GAP_MS },
  )

  const totalCount = aggregate.stats.reduce((sum, entry) => sum + (entry.totalCount ?? 0), 0)
  const fetched = aggregate.fetched

  const jobs = aggregate.jobs.map((job) => {
    const salary = salaryOfJob(job)
    return normalizeJob({
      ...job,
      key: job.key ?? `${job.source ?? 'jobsdb'}:${job.id}`,
      salary,
      salaryText: salaryShort(salary),
      experience: buildExperience({ teaser: job.teaser, classifications: job.classifications, title: job.title }),
    })
  })

  const prefs = { locations: input.locations ?? [], workTypes: input.workTypes ?? [] }
  const weights = normalizeWeights(input.weights)
  const rules = normalizeRules(input.rules)
  const profile = normalizeProfile(input.profile)
  let finalJobs = jobs
  let counts = null
  let dropped = { expired: 0, location: 0, workType: 0 }

  if (profile) {
    const matched = matchJobs(profile, jobs, prefs, now, { weights, rules })
    finalJobs = matched.jobs
    counts = matched.counts
    dropped = matched.dropped
  } else {
    // 没简历也要让「地点 / 工作类型」生效，只是不打分。
    const filtered = filterJobs(jobs, prefs, now)
    finalJobs = filtered.jobs.sort((left, right) => Date.parse(right.listedAt ?? '') - Date.parse(left.listedAt ?? ''))
    dropped = filtered.dropped
  }

  const runId = createRunId(new Date(now), options.random ?? Math.random)
  const run = {
    schemaVersion: 3,
    runId,
    createdAt: new Date(now).toISOString(),
    query: {
      keywords,
      maxPages,
      pageSize: PAGE_SIZE,
      postedWithinWeeks,
      totalCount,
      fetched,
      sources: sourceIds,
      sourceStats: aggregate.stats,
      locations: prefs.locations,
      workTypes: prefs.workTypes,
    },
    prefs,
    weights,
    rules,
    profile,
    profileSummary: profile
      ? { skills: profile.skills ?? [], titles: profile.titles ?? [], years: profile.years ?? null }
      : null,
    jobs: finalJobs,
    details: {},
    errors: [],
    stats: { dropped },
  }

  if (options.dataDir) {
    writeRun(options.dataDir, run)
    writePage(options.dataDir, projectRun(run))
  }

  return {
    ok: true,
    runId,
    jobs: finalJobs,
    counts,
    query: run.query,
    stats: { dropped },
    weights,
    rules,
  }
}
