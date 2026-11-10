import { normalizeRules, normalizeWeights } from '../../domain/match.js'
import { rescoreRun } from '../../domain/run.js'
import { readRun, writeRun } from '../../storage/run-store.js'
import { writePage } from '../../storage/page-store.js'
import { projectRun } from '../report/project.js'
import { resolveProfileYears } from '../../domain/profile.js'

/**
 * 改权重 / 经验年限后重排：不联网，只重算。
 * 这是唯一允许“打开页面后分数变化”的入口，必须由用户显式触发。
 */
export function rescore(runId, input = {}, options = {}) {
  const run = readRun(options.dataDir, runId)
  if (!run.profile) {
    throw Object.assign(new Error('run has no profile'), { code: 'E_BAD_PARAM', step: 'rescore' })
  }
  run.profile = { ...run.profile, years: resolveProfileYears(run.profile, input.years) }
  run.weights = normalizeWeights(input.weights ?? run.weights)
  run.rules = normalizeRules(input.rules ?? run.rules)
  const matched = rescoreRun(run)
  writeRun(options.dataDir, run)
  writePage(options.dataDir, projectRun(run), { guardRunId: runId })

  return {
    ok: true,
    runId,
    jobs: matched.jobs,
    counts: matched.counts,
    weights: run.weights,
    rules: run.rules,
  }
}
