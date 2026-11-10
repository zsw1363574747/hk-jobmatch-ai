import { findDetail } from '../../domain/job.js'
import { readRun } from '../../storage/run-store.js'
import { translateCached } from './source.js'

export async function translateJob(runId, jobId, field, options = {}) {
  const run = readRun(options.dataDir, runId)
  const detail = findDetail(run, jobId)
  if (!detail) return { ok: true, runId, jobId, field, text: '', cached: false, missing: 'detail' }

  const source =
    field === 'background'
      ? detail.companyProfile?.description ?? ''
      : field === 'jd'
        ? detail.contentText ?? ''
        : ''
  if (String(source).trim() === '') return { ok: true, runId, jobId, field, text: '', cached: false, empty: true }

  const result = await translateCached(options.dataDir, source, { fetchImpl: options.fetchImpl })
  return { ok: true, runId, jobId, field, ...result }
}
