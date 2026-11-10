import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './errors.js'

export const MEMORY_KINDS = Object.freeze(['pitfall', 'decision', 'lesson', 'preference'])

export function memoryDir(dataDir) {
  return join(dataDir, 'memory')
}

function fileOf(dataDir, kind) {
  return join(memoryDir(dataDir), `${kind}.jsonl`)
}

function parseKind(kind) {
  const value = String(kind ?? '')
  if (!MEMORY_KINDS.includes(value)) {
    throw Object.assign(fail('E_BAD_PARAM'), { step: 'memory', expected: MEMORY_KINDS.join('|') })
  }
  return value
}

/**
 * 追加一条记忆；JSONL 一行一条，跨会话可读。
 */
export function addEntry(dataDir, entry = {}) {
  const kind = parseKind(entry.kind)
  const text = String(entry.text ?? '').trim()
  if (text.length < 4) {
    throw Object.assign(fail('E_BAD_PARAM'), { step: 'addEntry', expected: 'text>=4' })
  }
  const record = {
    ts: new Date(Number.isFinite(entry.now) ? entry.now : Date.now()).toISOString(),
    kind,
    text,
    tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
  }
  try {
    mkdirSync(memoryDir(dataDir), { recursive: true })
    appendFileSync(fileOf(dataDir, kind), `${JSON.stringify(record)}\n`, 'utf8')
    return record
  } catch {
    throw Object.assign(fail('E_WRITE_FAILED'), { step: 'addEntry' })
  }
}

function readKind(dataDir, kind) {
  const file = fileOf(dataDir, kind)
  if (!existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {}
  }
  return rows
}

/**
 * 按 kind / 关键词召回；默认按时间倒序取 10 条。
 */
export function recall(dataDir, options = {}) {
  const kinds = options.kind ? [parseKind(options.kind)] : [...MEMORY_KINDS]
  const all = kinds.flatMap((kind) => readKind(dataDir, kind))
  const needle = String(options.query ?? '').trim().toLowerCase()
  const filtered = needle ? all.filter((row) => String(row.text).toLowerCase().includes(needle)) : all
  filtered.sort((left, right) => String(right.ts).localeCompare(String(left.ts)))
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50)
  return { total: filtered.length, entries: filtered.slice(0, limit) }
}

/**
 * 失败自动落坑：同一个 code + 场景 1 小时内只记一次，避免刷屏。
 * 记忆失败不影响主流程。
 */
export function recordPitfall(dataDir, entry = {}) {
  const code = String(entry.code ?? 'E_INTERNAL')
  const context = String(entry.context ?? '')
  const hint = String(entry.hint ?? '')
  const text = `${context ? `${context}：` : ''}${code}${hint ? ` — ${hint}` : ''}`
  const now = Date.now()
  try {
    const recent = readKind(dataDir, 'pitfall').slice(-50)
    for (const row of recent) {
      const same = row.text === text && Number.isFinite(Date.parse(row.ts))
      if (same && now - Date.parse(row.ts) < 3600000) return { recorded: false, record: row }
    }
    mkdirSync(memoryDir(dataDir), { recursive: true })
    const record = { ts: new Date(now).toISOString(), kind: 'pitfall', text, tags: ['auto', code] }
    appendFileSync(fileOf(dataDir, 'pitfall'), `${JSON.stringify(record)}\n`, 'utf8')
    return { recorded: true, record }
  } catch {
    return { recorded: false, record: null }
  }
}

export function stats(dataDir) {
  const counts = {}
  let total = 0
  for (const kind of MEMORY_KINDS) {
    const rows = readKind(dataDir, kind)
    counts[kind] = rows.length
    total += rows.length
  }
  return { total, counts }
}

/**
 * 第一次使用时把 bundle 里的种子记忆灌进来；已有内容不覆盖。
 */
export function seedStore(dataDir, seedPath) {
  if (!existsSync(seedPath)) {
    throw Object.assign(fail('E_NO_FILE'), { step: 'seedStore', expected: 'memory seed jsonl' })
  }
  const rows = []
  for (const line of readFileSync(seedPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {}
  }
  try {
    mkdirSync(memoryDir(dataDir), { recursive: true })
  } catch {
    throw Object.assign(fail('E_WRITE_FAILED'), { step: 'seedStore' })
  }
  let seeded = 0
  for (const kind of MEMORY_KINDS) {
    const file = fileOf(dataDir, kind)
    const current = existsSync(file) ? statSync(file).size : 0
    if (current > 0) continue
    const lines = rows.filter((row) => row.kind === kind).map((row) => JSON.stringify(row))
    if (lines.length === 0) continue
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    seeded += lines.length
  }
  return { seeded, ...stats(dataDir) }
}
