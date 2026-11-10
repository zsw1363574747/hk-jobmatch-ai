/**
 * 兼容 facade。
 *
 * CLI / plugin / 旧调用方都从这里拿命令；真正的实现按功能放在 features/*。
 * 这一层不再写业务逻辑，只负责错误记忆（memory pitfall）和统一导出。
 */
import { recordPitfall } from './memory.js'
import { createRunId } from './domain/run.js'
import { search as searchFeature } from './features/search/service.js'
import { loadDetails as loadDetailsFeature } from './features/details/service.js'
import { attachJd as attachJdFeature } from './features/details/attach-jd.js'
import { rescore as rescoreFeature } from './features/search/rescore.js'
import { report as reportFeature } from './features/report/service.js'
import { salaryProbe as salaryProbeFeature, salaryReport as salaryReportFeature, salaryPrecise as salaryPreciseFeature, salaryBands as salaryBandsFeature } from './features/salary/service.js'
import { news as newsFeature } from './features/news/service.js'
import { translateJob as translateJobFeature } from './features/translate/service.js'
import { insight as insightFeature } from './features/insight/service.js'
import { locations as locationsFeature } from './features/locations/service.js'
import {
  sources as sourcesFeature,
  probe as probeFeature,
  session as sessionFeature,
  browserLogin as browserLoginFeature,
} from './features/sources/service.js'

export { createRunId }

function rememberFailure(dataDir, context, error) {
  recordPitfall(dataDir, { code: error?.code ?? 'E_INTERNAL', hint: error?.hint, context })
}

async function guard(context, dataDir, run) {
  try {
    return await run()
  } catch (error) {
    rememberFailure(dataDir, context, error)
    throw error
  }
}

function guardSync(context, dataDir, run) {
  try {
    return run()
  } catch (error) {
    rememberFailure(dataDir, context, error)
    throw error
  }
}

export function search(input = {}, options = {}) {
  return guard('search', options.dataDir, () => searchFeature(input, options))
}

export function loadDetails(runId, options = {}) {
  return guard('jobs', options.dataDir, () => loadDetailsFeature(runId, options))
}

export function report(runId, verdicts = [], options = {}) {
  return guardSync('report', options.dataDir, () => reportFeature(runId, verdicts, options))
}

export function attachJd(runId, input = {}, options = {}) {
  return guardSync('attachJd', options.dataDir, () => attachJdFeature(runId, input, options))
}

export function rescore(runId, input = {}, options = {}) {
  return guardSync('rescore', options.dataDir, () => rescoreFeature(runId, input, options))
}

export function insight(runId, options = {}) {
  return guardSync('insight', options.dataDir, () => insightFeature(runId, options))
}

export function news(company, options = {}) {
  return guard('news', options.dataDir, () => newsFeature(company, options))
}

export function translateJob(runId, jobId, field, options = {}) {
  return guard('translate', options.dataDir, () => translateJobFeature(runId, jobId, field, options))
}

export function salaryProbe(runId, input = {}, options = {}) {
  return guard('salary', options.dataDir, () => salaryProbeFeature(runId, input, options))
}

export function salaryReport(input = {}, options = {}) {
  return guard('salary-report', options.dataDir, () => salaryReportFeature(input, options))
}

export function salaryBands(input = {}, options = {}) {
  return guard('salary-bands', options.dataDir, () => salaryBandsFeature(input, options))
}

export function salaryPrecise(runId, input = {}, options = {}) {
  return guard('salary-precise', options.dataDir, () => salaryPreciseFeature(runId, input, options))
}

export function session(options = {}) {
  return guard('session', options.dataDir, () => sessionFeature(options))
}

export function sources() {
  return sourcesFeature()
}

export function locations() {
  return locationsFeature()
}

export function probe(options = {}) {
  return guard('probe', options.dataDir, () => probeFeature(options))
}

export function browserLogin(input = {}, options = {}) {
  return guard('browserLogin', options.dataDir, () => browserLoginFeature(input, options))
}
