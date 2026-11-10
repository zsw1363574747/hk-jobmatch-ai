import { normalizeSalary, salaryShort } from '../../domain/salary.js'
import { findJob } from '../../domain/job.js'
import { readRun, writeRun } from '../../storage/run-store.js'
import { writePage } from '../../storage/page-store.js'
import { checkLogin, checkSalaryMatch } from '../../sources/session.js'
import { probeSalary, rememberSalaryBadge } from './probe.js'
import { preciseSalary } from './precise.js'
import { salaryReport as buildSalaryReport } from './report.js'
import { salaryBands as buildSalaryBands } from './bands.js'
import { projectRun } from '../report/project.js'

/**
 * 点开某条岗位时才补薪资：JD 明码直接用，没有就走平台筛选探针。
 * 只写这一条岗位的 salary，不动分数、不动排序。
 */
export async function salaryProbe(runId, input = {}, options = {}) {
  const run = readRun(options.dataDir, runId)
  const ref = String(input.key ?? input.id ?? '')
  const job = findJob(run, ref)
  if (!job) return { ok: false, code: 'E_RUN_NOT_FOUND', message: '这条岗位不在本次运行里' }

  job.salary = normalizeSalary(job.salary) ?? normalizeSalary(job.salaryLabel)
  if (job.salary?.kind === 'explicit') {
    return { ok: true, runId, key: ref, salary: job.salary, cached: true, probes: 0 }
  }

  const result = await probeSalary(job, {
    dataDir: options.dataDir,
    gapMs: options.gapMs,
    fetchImpl: options.fetchImpl,
  })
  if (!result.ok) {
    return {
      ok: false,
      runId,
      key: ref,
      code: result.reason ?? 'E_PROBE_FAILED',
      probes: result.probes ?? 0,
      message: '平台筛选也没探到（这家公司可能没填薪资）',
    }
  }

  job.salary = normalizeSalary(result.salary) ?? result.salary
  job.salaryText = salaryShort(job.salary)

  // 徽章在岗位详情页（data-automation="job-detail-salary-match"）。只在首次探针时读，
  // 读完写进 salary-cache，缓存命中时不再开浏览器（否则每次点开都多 5 秒）。
  const wantBadge = options.withBadge ?? process.env.JOBMATCH_SALARY_BADGE !== '0'
  if (wantBadge && !result.cached) {
    const badge = await checkSalaryMatch(job, { executable: options.executable, profile: options.profile }).catch(() => null)
    if (badge?.ok) {
      job.salary.expectedSalaryMatch = badge.match
      await rememberSalaryBadge(job, badge.match, options.dataDir)
    }
  }

  writeRun(options.dataDir, run)
  writePage(options.dataDir, projectRun(run), { guardRunId: runId })

  return {
    ok: true,
    runId,
    key: ref,
    salary: job.salary,
    salaryText: job.salaryText,
    cached: Boolean(result.cached),
    bands: result.bands ?? [],
    probes: result.probes ?? 0,
    ms: result.ms ?? 0,
  }
}

/** 关键词薪酬参考（报表）：关键词 + 相关岗位的中位数。 */
export async function salaryReport(input = {}, options = {}) {
  return buildSalaryReport(input, { fetchImpl: options.fetchImpl, gapMs: options.gapMs })
}

/** 按 JD 工作年限分档的明码薪资统计（慢，会逐条抓 JD）。 */
export async function salaryBands(input = {}, options = {}) {
  return buildSalaryBands(input, { fetchImpl: options.fetchImpl, gapMs: options.gapMs })
}

/**
 * 精确薪资：登录态下用「Salary match」徽章二分岗位薪资区间。
 * 会临时改账号的期望薪资，preciseSalary 内部 finally 恢复。
 */
export async function salaryPrecise(runId, input = {}, options = {}) {
  const run = readRun(options.dataDir, runId)
  const ref = String(input.key ?? input.id ?? '')
  const job = findJob(run, ref)
  if (!job) return { ok: false, code: 'E_RUN_NOT_FOUND', message: '这条岗位不在本次运行里' }
  if (String(job.source ?? 'jobsdb') !== 'jobsdb') {
    return { ok: false, code: 'E_UNSUPPORTED_SOURCE', message: '只有 JobsDB 岗位能二分薪资' }
  }

  const login = await checkLogin({ executable: options.executable, profile: options.profile })
  if (!login.loggedIn) {
    return { ok: false, code: 'E_NOT_LOGGED_IN', message: '先登录 jobsdb，才能用期望薪资二分' }
  }

  const result = await preciseSalary(job, {
    dataDir: options.dataDir,
    profile: options.profile,
    executable: options.executable,
  })
  if (!result.ok) {
    return {
      ok: false,
      code: result.reason ?? 'E_PRECISE_FAILED',
      message: result.reason === 'E_NO_BADGE'
        ? 'JobsDB 现在没返回「Salary match」（所有采样点都没有）。可能刚改过期望薪资、平台还没重算；过几分钟再试。原期望薪资已恢复。'
        : (result.message ?? '二分没找到「Salary match」区间（这家公司可能没填薪资）'),
      checks: result.checks ?? 0,
      restored: result.restored,
      restoreError: result.restoreError,
    }
  }

  job.salary = normalizeSalary(result.salary) ?? result.salary
  job.salaryText = salaryShort(job.salary)
  writeRun(options.dataDir, run)
  writePage(options.dataDir, projectRun(run), { guardRunId: runId })

  return {
    ok: true,
    runId,
    key: ref,
    salary: job.salary,
    salaryText: job.salaryText,
    checks: result.checks,
    cached: Boolean(result.cached),
    restored: result.restored,
    restoreError: result.restoreError,
    ms: result.ms ?? 0,
  }
}
