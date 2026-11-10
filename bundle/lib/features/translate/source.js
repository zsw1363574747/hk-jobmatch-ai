/**
 * 机器翻译（5.6.20）：走免 Key 的 Google gtx 端点，段落切块 + 本地缓存。
 * 联网仍然只经过 lib/net.js。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from '../../errors.js'
import { fetchJson } from '../../net.js'

const ENDPOINTS = [
  'https://translate.googleapis.com/translate_a/single',
  'https://translate.google.com/translate_a/single',
]
const MAX_CHUNK = 1500
const RETRY_DELAYS = [400, 1200]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function splitChunks(text, max = MAX_CHUNK) {
  const paragraphs = String(text ?? '')
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
  const chunks = []
  let current = ''
  const flush = () => {
    if (current !== '') {
      chunks.push(current)
      current = ''
    }
  }
  for (const paragraph of paragraphs) {
    if (paragraph.length > max) {
      flush()
      for (let index = 0; index < paragraph.length; index += max) {
        chunks.push(paragraph.slice(index, index + max))
      }
      continue
    }
    if (current !== '' && `${current}\n\n${paragraph}`.length > max) flush()
    current = current === '' ? paragraph : `${current}\n\n${paragraph}`
  }
  flush()
  return chunks
}

export async function translateText(text, options = {}) {
  const source = String(text ?? '').trim()
  if (source === '') return ''
  const from = options.from ?? 'en'
  const to = options.to ?? 'zh-CN'
  const chunks = splitChunks(source)
  const out = []
  for (const chunk of chunks) {
    let lastError = null
    let zh = ''
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1])
      const endpoint = ENDPOINTS[attempt % ENDPOINTS.length]
      const url = `${endpoint}?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(chunk)}`
      try {
        const data = await fetchJson(url, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })
        zh = Array.isArray(data?.[0]) ? data[0].map((segment) => (Array.isArray(segment) ? segment[0] ?? '' : '')).join('') : ''
        if (zh.trim() !== '') {
          lastError = null
          break
        }
        lastError = Object.assign(fail('E_PARSE_FAILED'), { step: 'translateText' })
      } catch (error) {
        lastError = error
      }
    }
    if (lastError) throw lastError
    out.push(zh.trim())
  }
  return out.join('\n\n')
}

function cachePath(dataDir) {
  return join(dataDir, 'translations-cache.json')
}

function keyOf(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
}

function readCache(dataDir) {
  const file = cachePath(dataDir)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeCache(dataDir, cache) {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(cachePath(dataDir), JSON.stringify(cache), 'utf8')
  } catch {
    // 缓存写失败不影响翻译结果
  }
}

export async function translateCached(dataDir, text, options = {}) {
  const source = String(text ?? '').trim()
  const key = keyOf(source)
  const cache = dataDir ? readCache(dataDir) : {}
  if (cache[key]) return { text: cache[key], cached: true }
  const translated = await translateText(source, options)
  if (dataDir) {
    cache[key] = translated
    writeCache(dataDir, cache)
  }
  return { text: translated, cached: false }
}
