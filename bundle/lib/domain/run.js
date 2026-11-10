import { matchJobs } from './match.js'

export const RUN_SCHEMA_VERSION = 3

export function createRunId(date = new Date(), random = Math.random) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `r-${stamp}-${Math.floor(random() * 0x10000).toString(16).padStart(4, '0')}`
}

/**
 * 用 run 里存的画像 + 权重重算全部岗位。
 * 这是唯一的“重排”入口；详情合并不应该调用它。
 */
export function rescoreRun(run, { now = Date.now() } = {}) {
  if (!run?.profile) return null
  const matched = matchJobs(run.profile, run.jobs ?? [], run.prefs ?? {}, now, {
    weights: run.weights,
    rules: run.rules,
  })
  run.jobs = matched.jobs
  run.weights = matched.weights
  run.rules = matched.rules
  return matched
}

/** 轻量校验：写入前抓明显坏数据，避免把 latest 写成半截。 */
export function assertRun(run) {
  if (!run || typeof run !== 'object') throw new Error('run must be an object')
  if (typeof run.runId !== 'string' || run.runId === '') throw new Error('run.runId is required')
  if (!Array.isArray(run.jobs)) throw new Error('run.jobs must be an array')
  if (run.details != null && typeof run.details !== 'object') throw new Error('run.details must be an object')
  return run
}

/** 详情表只保留内容，不把整个 HTML 塞进 run。 */
export function detailForStorage(detail) {
  if (!detail) return null
  return {
    ...detail,
    contentHtml: '',
  }
}
