import { readFileSync } from 'node:fs'
import { fail } from '../../errors.js'

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countOccurrences(haystack, pattern) {
  const needle = pattern.toLowerCase()
  const isAscii = /^[\x00-\x7F]+$/.test(needle)
  if (isAscii) {
    const re = new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'g')
    return (haystack.match(re) ?? []).length
  }
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * 读取技能词典；形状不对就抛 E_LEXICON_BAD（5.6.4 前置）。
 */
export function loadLexicon(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw Object.assign(fail('E_LEXICON_BAD'), { step: 'loadLexicon' })
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw Object.assign(fail('E_LEXICON_BAD'), { step: 'loadLexicon' })
  }
  const hasSkills = Array.isArray(data.skills) && data.skills.length > 0
  const hasTitles = Array.isArray(data.titles) && data.titles.length > 0
  if (!hasSkills || !hasTitles) {
    throw Object.assign(fail('E_LEXICON_BAD'), { step: 'loadLexicon', expected: 'skills[] + titles[]' })
  }
  return data
}

/**
 * 在文本里数每个词条命中几次；返回 [{ label, count, domain? }]，按命中数降序。
 */
export function matchLexicon(text, entries) {
  const haystack = String(text ?? '').toLowerCase()
  const hits = []
  for (const entry of entries ?? []) {
    const patterns = Array.isArray(entry.patterns) ? entry.patterns : [entry.label]
    const count = patterns.reduce((sum, pattern) => sum + countOccurrences(haystack, pattern), 0)
    if (count > 0) {
      const hit = { label: entry.label, count }
      if (entry.domain) hit.domain = entry.domain
      hits.push(hit)
    }
  }
  return hits.sort((a, b) => b.count - a.count)
}
