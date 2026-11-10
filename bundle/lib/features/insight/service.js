import { buildInsight } from './build.js'
import { listRunIds, readRun } from '../../storage/run-store.js'

export function insight(runId, options = {}) {
  const dataDir = options.dataDir
  // scope=all：把 data/runs 里所有轮次合并统计（按 job key 去重），样本比单轮大得多。
  if (options.allRuns) {
    const runs = []
    for (const id of listRunIds(dataDir)) {
      try {
        runs.push(readRun(dataDir, id))
      } catch {
        // 坏掉的 run 跳过，不影响其余轮次
      }
    }
    if (runs.length > 0) {
      return { ok: true, runId: runs[0].runId ?? runId, scope: 'all', ...buildInsight(runs) }
    }
  }
  return { ok: true, runId, scope: 'run', ...buildInsight(readRun(dataDir, runId)) }
}
