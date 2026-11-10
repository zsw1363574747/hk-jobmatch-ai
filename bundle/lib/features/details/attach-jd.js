import { fail } from '../../errors.js'
import { findJob } from '../../domain/job.js'
import { rescoreRun } from '../../domain/run.js'
import { updateRun } from '../../storage/run-store.js'
import { writePage } from '../../storage/page-store.js'
import { projectRun } from '../report/project.js'
import { applyDetailToJob } from '../../domain/job.js'

/**
 * 手动贴 JD 是显式命令：合并正文 → 重算经验 → 重排 → 投影。
 */
export function attachJd(runId, input = {}, options = {}) {
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (text.length < 20) {
    throw Object.assign(fail('E_BAD_PARAM'), { step: 'attachJd', expected: 'text >= 20 chars' })
  }

  let updated = null
  const run = updateRun(options.dataDir, runId, (current) => {
    current.details = current.details ?? {}
    const id = String(input.id ?? input.key ?? '')
    const job = findJob(current, id)
    if (!job) throw Object.assign(fail('E_RUN_NOT_FOUND'), { step: 'attachJd' })
    const key = job.key ?? `jobsdb:${job.id}`
    const detail = {
      id: job.id,
      title: job.title,
      company: job.company,
      url: job.url,
      contentText: text,
      contentChars: text.length,
      contentHtml: '',
      salary: job.salaryLabel ?? '',
      location: (job.locations ?? [])[0] ?? '',
      source: 'manual',
      lite: false,
    }
    current.details[key] = detail
    applyDetailToJob(job, detail)
    updated = job
    rescoreRun(current)
    return current
  })

  const job = findJob(run, String(input.id ?? input.key ?? '')) ?? updated
  if (options.dataDir) writePage(options.dataDir, projectRun(run), { guardRunId: runId })

  return {
    ok: true,
    runId,
    job,
    detail: run.details?.[job?.key ?? ''] ?? null,
    counts: projectRun(run).counts,
    weights: run.weights ?? null,
    rules: run.rules ?? null,
  }
}
