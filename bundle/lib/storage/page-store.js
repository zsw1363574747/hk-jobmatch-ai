import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * latest.json 只是页面投影：只允许 writePage 从 projectRun(run) 重写，
 * 不允许任何命令把它当输入再 patch。这样 run 和 page 不会再互相覆盖。
 */
export function pagePath(dataDir) {
  return join(dataDir, 'latest.json')
}

export function pageExists(dataDir) {
  return existsSync(pagePath(dataDir))
}

export function readPage(dataDir) {
  return JSON.parse(readFileSync(pagePath(dataDir), 'utf8'))
}

export function writePage(dataDir, page, { guardRunId = null } = {}) {
  if (guardRunId) {
    try {
      const current = readPage(dataDir)
      if (current?.runId !== guardRunId) return null
    } catch {
      // 没有旧页面时可以直接写
    }
  }
  const file = pagePath(dataDir)
  writeFileSync(file, JSON.stringify(page, null, 2), 'utf8')
  return file
}
