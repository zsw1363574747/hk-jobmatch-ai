import { fail } from '../../errors.js'
import { readRun } from '../../storage/run-store.js'
import { writePage } from '../../storage/page-store.js'
import { writeReport } from '../../storage/report-store.js'
import { projectRun } from './project.js'
import { buildMarkdown } from './markdown.js'

function validateVerdicts(run, verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) return
  const known = new Set((run.jobs ?? []).flatMap((job) => [String(job.key ?? ''), String(job.id)]).filter(Boolean))
  for (const verdict of verdicts) {
    const goodId = verdict && known.has(String(verdict.id))
    const goodFit = Number.isInteger(verdict?.fit) && verdict.fit >= 0 && verdict.fit <= 100
    const goodTier = ['A', 'B', 'C', 'X'].includes(verdict?.tier)
    const goodReasons = Array.isArray(verdict?.reasons) && verdict.reasons.length >= 2
    const goodGaps = Array.isArray(verdict?.gaps) && verdict.gaps.length >= 1
    if (!goodId || !goodFit || !goodTier || !goodReasons || !goodGaps) {
      throw Object.assign(fail('E_VERDICT_BAD'), {
        step: 'report',
        expected: 'id/fit/tier/reasons>=2/gaps>=1',
      })
    }
  }
}

/**
 * 报告命令：run → page 投影 → latest + report.md。
 * latest 只在这里和 search 命令里写，其他地方不许写。
 */
export function report(runId, verdicts = [], options = {}) {
  const run = readRun(options.dataDir, runId)
  const warnings = []
  if (!run.details || Object.keys(run.details).length === 0) warnings.push('no_details')
  validateVerdicts(run, verdicts)

  const data = projectRun(run, verdicts)
  const markdown = buildMarkdown(data)
  const page = writePage(options.dataDir, data, { guardRunId: runId })
  const markdownPath = writeReport(options.dataDir, runId, markdown)

  return {
    ok: true,
    runId,
    page: { path: page },
    markdown: { path: markdownPath },
    counts: data.counts,
    warnings,
  }
}
