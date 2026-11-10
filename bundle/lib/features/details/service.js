import { MAX_DETAILS, REQUEST_GAP_MS } from '../../constants.js'
import { groupBy, mapLimit } from '../../concurrency.js'
import { applyDetailToJob, findJob } from '../../domain/job.js'
import { getSource, fetchDetail as fetchSourceDetail } from '../../sources/index.js'
import { readRun, writeRun } from '../../storage/run-store.js'
import { writePage } from '../../storage/page-store.js'
import { projectRun } from '../report/project.js'

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function countTiers(jobs = []) {
  const counts = { A: 0, B: 0, C: 0, X: 0 }
  for (const job of jobs) if (counts[job.tier] !== undefined) counts[job.tier] += 1
  return counts
}

/**
 * 详情命令：抓 JD、合并进 run.details / job。
 *
 * 关键规则：
 * - 不 rescore、不排序、不改分数（重排是独立命令）；
 * - 只写 run；latest 只在 guardRunId 仍匹配时更新，避免覆盖新一轮搜索。
 */
export async function loadDetails(runId, options = {}) {
  const dataDir = options.dataDir
  const run = readRun(dataDir, runId)
  run.details = run.details ?? {}

  // all=true：本轮全部岗位都补（「JD 要求排行」要全量样本时用）；否则仍受 MAX_DETAILS 上限保护。
  const limit = options.all === true
    ? run.jobs.length
    : Math.min(MAX_DETAILS, Math.max(1, Number(options.limit) || MAX_DETAILS))
  const ids =
    Array.isArray(options.ids) && options.ids.length > 0
      ? options.ids.map(String)
      : run.jobs.slice(0, limit).map((job) => job.key ?? job.id)

  const sleep = options.sleep ?? defaultSleep
  // 并发只对 HTTP 来源生效；浏览器来源共用一个 profile，必须串行。
  const parallel = Math.max(1, Math.min(6, Number(options.parallel) || 1))
  // 预抓详情时没必要每条都去拉公司档案（多一次页面请求），点开时再补。
  const withProfile = options.withProfile !== false
  // 按「模块本身」判断浏览器来源，而不是按「当前启用列表」——
  // 停用 CTgoodjobs 之后，历史 run 里的 CTgoodjobs 详情仍然要串行开浏览器补。
  const isBrowserSource = (sourceId) => {
    try {
      return Boolean(getSource(sourceId).descriptor.needsBrowser)
    } catch {
      return false
    }
  }
  const errors = []
  let fetched = 0
  let reused = 0
  let blocked = false

  /** 把一条「详情结果」落到 run 里（成功写 detail，失败退到 teaser）。 */
  const applyResult = (ref, job, result) => {
    if (result.warnings?.some((warning) => warning.blocked)) blocked = true
    if (result.ok && result.detail) {
      run.details[ref] = result.detail
      applyDetailToJob(job, result.detail)
      fetched += 1
      return
    }
    errors.push({ id: ref, code: result.code ?? 'E_INTERNAL', source: job.source })
    if (result.warnings?.[0]?.code === 'E_BLOCKED') blocked = true
    // 退路：保留搜索阶段的 teaser，标 lite，不冒充正文。
    const lite = {
      id: job.id,
      title: job.title,
      company: job.company,
      url: job.url,
      contentText: job.teaser ?? '',
      contentChars: (job.teaser ?? '').length,
      contentHtml: '',
      salary: job.salaryLabel ?? '',
      location: (job.locations ?? [])[0] ?? '',
      source: 'teaser',
      lite: true,
    }
    run.details[ref] = lite
    applyDetailToJob(job, lite)
  }

  /** 已经有正文且（需要时）已有公司档案，就直接复用，不再发请求。 */
  const reusable = (ref) => {
    const existing = run.details?.[ref]
    return Boolean(existing && existing.contentChars > 0 && (!withProfile || existing.companyProfile))
  }

  const processRef = async (ref) => {
    const job = findJob(run, ref)
    if (!job) {
      errors.push({ id: ref, code: 'E_JOB_GONE' })
      return
    }
    if (reusable(ref)) {
      applyDetailToJob(job, run.details[ref])
      reused += 1
      return
    }
    const result = await fetchSourceDetail(job, {
      fetchImpl: options.fetchImpl,
      sleep,
      gapMs: REQUEST_GAP_MS,
      withProfile,
      existing: run.details?.[ref],
    })
    applyResult(ref, job, result)
  }

  const httpRefs = []
  const browserRefs = []
  for (const ref of ids) {
    const job = findJob(run, ref)
    if (job && isBrowserSource(job.source)) browserRefs.push(ref)
    else httpRefs.push(ref)
  }

  if (parallel > 1) {
    await mapLimit(httpRefs, parallel, processRef)
  } else {
    for (let index = 0; index < httpRefs.length; index += 1) {
      if (index > 0) await sleep(REQUEST_GAP_MS)
      await processRef(httpRefs[index])
    }
  }

  // 浏览器来源：支持 fetchDetails 的（CTgoodjobs）一个会话批量开页，其余逐条
  const browserGroups = groupBy(browserRefs, (ref) => String(findJob(run, ref)?.source ?? ''))
  for (const [sourceId, refs] of browserGroups) {
    const module = getSource(sourceId)
    if (typeof module.fetchDetails === 'function') {
      const pending = refs.filter((ref) => !reusable(ref))
      for (const ref of refs.filter(reusable)) {
        applyDetailToJob(findJob(run, ref), run.details[ref])
        reused += 1
      }
      if (pending.length === 0) continue
      const jobs = pending.map((ref) => findJob(run, ref))
      const results = await module.fetchDetails(jobs, {
        profile: options.profile,
        executable: options.executable,
        headless: options.headless,
        settleMs: options.settleMs,
      })
      pending.forEach((ref, index) => applyResult(ref, jobs[index], results[index] ?? { ok: false, code: 'E_INTERNAL' }))
      continue
    }
    for (let index = 0; index < refs.length; index += 1) {
      if (index > 0) await sleep(REQUEST_GAP_MS)
      await processRef(refs[index])
    }
  }

  run.errors = [...(run.errors ?? []), ...errors]
  if (dataDir) {
    writeRun(dataDir, run)
    // 详情是命令：可以更新投影，但只在 latest 仍属于同一 run 时写，避免覆盖新一轮。
    writePage(dataDir, projectRun(run), { guardRunId: runId })
  }

  return {
    ok: true,
    runId,
    jobs: ids.map((id) => run.details[id]).filter(Boolean),
    fetched,
    reused,
    errors,
    blocked,
    counts: countTiers(run.jobs),
    weights: run.weights ?? null,
    rules: run.rules ?? null,
    ranked: run.jobs ?? [],
  }
}
