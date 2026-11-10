import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fail } from '../../errors.js'
import { decodeEntities } from '../../text.js'
import { matchLexicon } from './lexicon.js'
import { understandResume } from './understanding.js'
import { extractPdfText } from './pdf.js'
import { MAX_RESUME_CHARS, MAX_SKILLS, MAX_TITLES, MIN_RESUME_CHARS } from '../../constants.js'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_SCAN_BYTES = 66 * 1024

function corrupt(step) {
  return Object.assign(fail('E_DOCX_CORRUPT'), { step })
}

function findEocd(buffer) {
  const floor = Math.max(0, buffer.length - EOCD_SCAN_BYTES)
  for (let index = buffer.length - 22; index >= floor; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) return index
  }
  return -1
}

/**
 * 零依赖读 .docx：EOCD → 中央目录 → word/document.xml → inflateRaw → 去标签。
 * 任何一步不对都抛 E_DOCX_CORRUPT（5.6.3）。
 */
export function parseDocx(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? '')
  if (buffer.length < 22) throw corrupt('parseDocx:size')

  const eocd = findEocd(buffer)
  if (eocd < 0) throw corrupt('parseDocx:eocd')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  let target = null

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw corrupt('parseDocx:central')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    if (name === 'word/document.xml') {
      target = { method, compressedSize, localOffset }
      break
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  if (!target) throw corrupt('parseDocx:document-xml')

  const local = target.localOffset
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw corrupt('parseDocx:local-header')
  }
  const localNameLength = buffer.readUInt16LE(local + 26)
  const localExtraLength = buffer.readUInt16LE(local + 28)
  const dataStart = local + 30 + localNameLength + localExtraLength
  const dataEnd = dataStart + target.compressedSize
  if (dataEnd > buffer.length) throw corrupt('parseDocx:data-range')

  const raw = buffer.subarray(dataStart, dataEnd)
  let xml
  if (target.method === 0) {
    xml = raw.toString('utf8')
  } else if (target.method === 8) {
    try {
      xml = inflateRawSync(raw).toString('utf8')
    } catch {
      throw corrupt('parseDocx:inflate')
    }
  } else {
    throw corrupt('parseDocx:method')
  }

  const text = xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
  const plain = decodeEntities(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')

  if (plain === '') throw corrupt('parseDocx:empty')
  return plain
}

/**
 * 有些 PDF 抽出来是「一个词一行」的碎片（文字层按 run 切开了）。
 * 这里只在明显碎片化时，把短行拼回句子：中文直接接上，英文单词之间补空格，
 * ● 项目符号与「教育经历 / 实习经历」这类小标题单独成行。
 */
function looksFragmented(lines) {
  if (lines.length < 40) return false
  const short = lines.filter((line) => line.length <= 6).length
  return short / lines.length > 0.5
}

function defragment(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!looksFragmented(lines)) return String(text ?? '')
  const ascii = /[A-Za-z0-9]/
  const headings = /^(教育经历|实习经历|工作经历|项目经历|个人技能|专业技能|技能|自我评价|获奖经历)[:：]?$/
  let out = ''
  for (const line of lines) {
    if (/^[●•·▪◦]/.test(line) || /^【/.test(line)) {
      out += `\n${line}`
      continue
    }
    if (headings.test(line)) {
      out += `\n${line}\n`
      continue
    }
    // 带两个日期（或「2024.08-2024.12」）的短行基本都是「公司/职位/时间」标题，单独成段
    const dateTokens = line.match(/\d{4}\s*[.\-/年]/g) ?? []
    if (dateTokens.length >= 2 && line.length <= 120) {
      out += `\n${line}`
      continue
    }
    if (out === '') {
      out = line
      continue
    }
    const previous = out.slice(-1)
    out += ascii.test(previous) && ascii.test(line[0]) ? ` ${line}` : line
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

function normalizeText(text, warnings) {
  const cleaned = defragment(String(text ?? '').replace(/^\uFEFF/, '').trim())
  if (cleaned.length < MIN_RESUME_CHARS) {
    throw Object.assign(fail('E_RESUME_TOO_SHORT'), { step: 'extractResumeText', expected: `>= ${MIN_RESUME_CHARS}` })
  }
  if (cleaned.length > MAX_RESUME_CHARS) {
    warnings.push('resume_truncated')
    return cleaned.slice(0, MAX_RESUME_CHARS)
  }
  return cleaned
}

/**
 * 简历入口（5.6.2）：.txt/.md 直读、.docx 走 parseDocx、.pdf 明确拒绝、文本直接收。
 */
export function extractResumeText(input = {}) {
  const hasPath = typeof input.path === 'string' && input.path.trim() !== ''
  const hasText = typeof input.text === 'string' && input.text.trim() !== ''
  if (!hasPath && !hasText) {
    throw Object.assign(fail('E_RESUME_MISSING'), { step: 'extractResumeText', expected: 'path|text' })
  }

  const warnings = []
  if (hasText) {
    const text = normalizeText(input.text, warnings)
    return { source: { kind: 'text' }, text, textChars: text.length, warnings }
  }

  let stats
  try {
    stats = statSync(input.path)
  } catch {
    throw Object.assign(fail('E_NO_FILE'), { step: 'extractResumeText' })
  }
  if (stats.isDirectory()) {
    throw Object.assign(fail('E_BAD_PARAM'), { step: 'extractResumeText', expected: 'file path' })
  }

  const extension = extname(input.path).toLowerCase()
  let raw
  if (extension === '.txt' || extension === '.md') {
    raw = readFileSync(input.path, 'utf8')
  } else if (extension === '.docx') {
    try {
      raw = parseDocx(readFileSync(input.path))
    } catch (err) {
      if (err && err.code) throw err
      throw corrupt('extractResumeText:docx')
    }
  } else if (extension === '.pdf') {
    try {
      raw = extractPdfText(readFileSync(input.path))
    } catch (err) {
      if (err && err.code) throw err
      throw Object.assign(fail('E_PDF_UNSUPPORTED'), { step: 'extractResumeText' })
    }
  } else {
    throw Object.assign(fail('E_RESUME_FORMAT'), { step: 'extractResumeText', expected: '.txt/.md/.docx/.pdf' })
  }

  const text = normalizeText(raw, warnings)
  return {
    source: { kind: 'file', name: basename(input.path), bytes: stats.size },
    text,
    textChars: text.length,
    warnings,
  }
}

function extractYears(text) {
  const found = []
  for (const match of text.matchAll(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi)) found.push(Number(match[1]))
  // 中文必须带「经验」上下文：否则「2021年3月」会被读成 21 年经验。
  for (const match of text.matchAll(/(\d{1,2})\s*年(?:以上)?[^。\n]{0,12}?(?:经验|經歷|经历)/g)) found.push(Number(match[1]))
  const valid = found.filter((value) => Number.isInteger(value) && value > 0 && value <= 60)
  if (valid.length > 0) return Math.max(...valid)
  // 应届生往往不写「X 年经验」，但要按 0 年算，不能当「未知」放任高分
  if (/(应届|毕业生|graduating|fresh\s+grad|20\d{2}\s*届|class\s+of\s+20\d{2})/i.test(text)) return 0
  return null
}

/**
 * 画像解析（5.6.4）：技能、职位、领域、语言、年限。
 */
export function parseProfile(text, lexicon) {
  const source = String(text ?? '')
  const lower = source.toLowerCase()

  const skillHits = matchLexicon(lower, lexicon.skills).slice(0, MAX_SKILLS)
  const titleHits = matchLexicon(lower, lexicon.titles).slice(0, MAX_TITLES)
  const languageHits = matchLexicon(lower, lexicon.languages)

  const skills = skillHits.map((hit) => hit.label)
  const titles = titleHits.map((hit) => hit.label)
  const domains = [...new Set(titleHits.map((hit) => hit.domain).filter(Boolean))]
  const languages = languageHits.map((hit) => hit.label)
  const years = extractYears(source)

  const warnings = []
  if (skills.length === 0 && titles.length === 0) warnings.push('profile_empty')

  // 先读懂「做了什么」，再从结构里反推关键词；关键词只是理解的结果，不是输入。
  const understanding = understandResume(source, {
    skills: skillHits,
    titles: titleHits,
    domains,
    years,
  })

  return { skills, titles, domains: [...new Set([...domains, ...understanding.domains])], languages, years, understanding, warnings }
}
