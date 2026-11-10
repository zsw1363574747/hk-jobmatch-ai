import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function reportPath(dataDir, runId) {
  return join(dataDir, 'runs', `${runId}.report.md`)
}

export function writeReport(dataDir, runId, markdown) {
  const file = reportPath(dataDir, runId)
  writeFileSync(file, markdown, 'utf8')
  return file
}
