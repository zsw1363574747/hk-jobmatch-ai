import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from '../errors.js'
import { assertRun, RUN_SCHEMA_VERSION } from '../domain/run.js'

function writeFailed(step) {
  return Object.assign(fail('E_WRITE_FAILED'), { step })
}

function atomicWrite(file, text) {
  try {
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, text, 'utf8')
    // Windows 的 rename 不覆盖已存在的文件：先删目标再改名。
    if (existsSync(file)) unlinkSync(file)
    renameSync(temporary, file)
  } catch {
    throw writeFailed('atomicWrite')
  }
}

export function runPath(dataDir, runId) {
  return join(dataDir, 'runs', `${runId}.json`)
}

export function runExists(dataDir, runId) {
  return existsSync(runPath(dataDir, runId))
}

export function writeRun(dataDir, run) {
  assertRun(run)
  try {
    mkdirSync(join(dataDir, 'runs'), { recursive: true })
  } catch {
    throw writeFailed('writeRun')
  }
  const normalized = { ...run, schemaVersion: RUN_SCHEMA_VERSION }
  const file = runPath(dataDir, run.runId)
  atomicWrite(file, JSON.stringify(normalized, null, 2))
  return file
}

export function readRun(dataDir, runId) {
  try {
    return JSON.parse(readFileSync(runPath(dataDir, runId), 'utf8'))
  } catch {
    throw Object.assign(fail('E_RUN_NOT_FOUND'), {
      step: 'readRun',
      hint: '这一轮只有页面快照，没有完整 run；重新搜索一次即可恢复',
    })
  }
}

/** 列出所有 run id，按「新 → 旧」排（runId 形如 r-20261110000023-a3b0，可直接按字符串比较）。 */
export function listRunIds(dataDir) {
  try {
    return readdirSync(join(dataDir, 'runs'))
      .filter((name) => name.endsWith('.json') && !name.includes('.tmp'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** 读 run，交给 mutator 修改，再原子写回；所有命令都走这里。 */
export function updateRun(dataDir, runId, mutator) {
  const run = readRun(dataDir, runId)
  const result = mutator(run) ?? run
  writeRun(dataDir, result)
  return result
}
