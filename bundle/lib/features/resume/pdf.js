import { inflateSync } from 'node:zlib'
import { fail } from '../../errors.js'

/**
 * 零依赖 PDF 文本抽取（5.6.2 扩展）。
 * 覆盖：未加密、文字型 PDF（Word / Edge 打印 / LaTeX 导出）。
 * 不覆盖：扫描件（无文字层）、加密 PDF —— 抛 E_PDF_UNSUPPORTED 并提示改用 docx / 粘贴。
 */

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b/g
const MAX_STREAM_BYTES = 64 * 1024 * 1024

function unsupported(step, expected) {
  return Object.assign(fail('E_PDF_UNSUPPORTED'), { step, expected })
}

function asLatin1(buffer) {
  return buffer.toString('latin1')
}

function findBytes(buffer, needle, from) {
  return buffer.indexOf(Buffer.from(needle, 'latin1'), from)
}

/** 解析所有 `n g obj ... endobj`，返回 id → { dict, stream }。 */
function parseObjects(buffer) {
  const objects = new Map()
  const latin = asLatin1(buffer)
  OBJ_RE.lastIndex = 0
  let match
  while ((match = OBJ_RE.exec(latin)) !== null) {
    const id = Number(match[1])
    const bodyStart = match.index + match[0].length
    const end = findBytes(buffer, 'endobj', bodyStart)
    if (end < 0) break
    const body = buffer.subarray(bodyStart, end)
    const streamAt = findBytes(body, 'stream', 0)
    let dict = body
    let stream = null
    if (streamAt >= 0) {
      dict = body.subarray(0, streamAt)
      let dataStart = streamAt + 'stream'.length
      if (body[dataStart] === 0x0d) dataStart += 1
      if (body[dataStart] === 0x0a) dataStart += 1
      const streamEnd = findBytes(body, 'endstream', dataStart)
      if (streamEnd >= 0) stream = body.subarray(dataStart, streamEnd)
    }
    objects.set(id, { dict: asLatin1(dict), stream })
    OBJ_RE.lastIndex = end
  }
  return objects
}

function refId(dict, key) {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict)
  return match ? Number(match[1]) : null
}

function refIds(dict, key) {
  const arrayMatch = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(dict)
  if (arrayMatch) {
    return [...arrayMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((item) => Number(item[1]))
  }
  const one = refId(dict, key)
  return one === null ? [] : [one]
}

function decodeStream(buffer, dict) {
  if (!buffer) return Buffer.alloc(0)
  if (buffer.length > MAX_STREAM_BYTES) throw unsupported('decodeStream:size', 'stream < 64MB')
  if (!/\/FlateDecode/.test(dict)) {
    if (/\/Filter/.test(dict)) return Buffer.alloc(0)
    return buffer
  }
  try {
    return inflateSync(buffer)
  } catch {
    return Buffer.alloc(0)
  }
}

function streamOf(objects, id) {
  const target = objects.get(id)
  if (!target) return Buffer.alloc(0)
  return decodeStream(target.stream, target.dict)
}

/** 解析 ToUnicode CMap：bfchar + bfrange，返回 Map<code, string>。 */
export function parseCMap(text) {
  const map = new Map()
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), hexToText(pair[2]))
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]
    for (const item of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)/g)) {
      const start = parseInt(item[1], 16)
      const end = parseInt(item[2], 16)
      const target = item[3]
      if (target.startsWith('[')) {
        const list = [...target.matchAll(/<([0-9A-Fa-f]+)>/g)].map((one) => hexToText(one[1]))
        list.forEach((value, index) => map.set(start + index, value))
      } else {
        const base = parseInt(target.slice(1, -1), 16)
        const width = target.length - 2
        for (let code = start; code <= end && code - start < 65536; code += 1) {
          const hex = (base + code - start).toString(16).toUpperCase().padStart(width, '0')
          map.set(code, hexToText(hex))
        }
      }
    }
  }
  return map
}

function hexToText(hex) {
  const clean = hex.padStart(Math.ceil(hex.length / 4) * 4, '0')
  let out = ''
  for (let index = 0; index < clean.length; index += 4) {
    out += String.fromCharCode(parseInt(clean.slice(index, index + 4), 16))
  }
  return out.replace(/\u0000/g, '')
}

/** 当前页的字体表：资源名 → { map, twoByte }。 */
function pageFonts(objects, pageDict) {
  const fonts = new Map()
  let resources = pageDict
  const resourceRef = refId(pageDict, 'Resources')
  if (resourceRef !== null && objects.get(resourceRef)) resources = objects.get(resourceRef).dict
  const fontDictMatch = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)
  if (!fontDictMatch) return fonts
  for (const entry of fontDictMatch[1].matchAll(/\/([A-Za-z0-9]+)\s+(\d+)\s+\d+\s+R/g)) {
    const name = entry[1]
    const fontId = Number(entry[2])
    const font = objects.get(fontId)
    if (!font) continue
    const twoByte = /\/Identity-[HV]|\/Type0/.test(font.dict)
    let map = new Map()
    const cmapRef = refId(font.dict, 'ToUnicode')
    if (cmapRef !== null) {
      const cmapBytes = streamOf(objects, cmapRef)
      if (cmapBytes.length > 0) map = parseCMap(asLatin1(cmapBytes))
    }
    fonts.set(name, { map, twoByte })
  }
  return fonts
}

function decodeChunk(bytes, font) {
  if (bytes.length === 0) return ''
  if (!font) {
    let out = ''
    for (const byte of bytes) out += String.fromCharCode(byte)
    return out
  }
  if (!font.twoByte) {
    let out = ''
    for (const byte of bytes) out += font.map.get(byte) ?? String.fromCharCode(byte)
    return out
  }
  let out = ''
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const code = (bytes[index] << 8) | bytes[index + 1]
    out += font.map.get(code) ?? ''
  }
  return out
}

/** 解析内容流里的文本算子（Tj / TJ / ' / "），按 Td/TD/T* 断行。 */
export function extractContentText(content, fonts) {
  const source = asLatin1(content)
  const out = []
  const stack = []
  let font = null
  let index = 0
  const pushSpace = () => {
    if (out.length > 0 && !/\s$/.test(out[out.length - 1])) out.push(' ')
  }
  const pushNewline = () => {
    if (out.length > 0 && !/\n$/.test(out[out.length - 1])) out.push('\n')
  }
  while (index < source.length) {
    const char = source[index]
    if (char === '(') {
      let depth = 1
      let cursor = index + 1
      const bytes = []
      while (cursor < source.length && depth > 0) {
        const current = source[cursor]
        if (current === '\\') {
          const next = source[cursor + 1]
          const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }
          if (next === undefined) break
          if (next in escapes) {
            bytes.push(escapes[next])
            cursor += 2
            continue
          }
          if (/[0-7]/.test(next)) {
            const octal = /^[0-7]{1,3}/.exec(source.slice(cursor + 1))[0]
            bytes.push(parseInt(octal, 8))
            cursor += 1 + octal.length
            continue
          }
          if (next === '\n') {
            cursor += 2
            continue
          }
          bytes.push(next.charCodeAt(0))
          cursor += 2
          continue
        }
        if (current === '(') depth += 1
        if (current === ')') {
          depth -= 1
          if (depth === 0) break
        }
        bytes.push(current.charCodeAt(0))
        cursor += 1
      }
      stack.push({ type: 'string', bytes })
      index = cursor + 1
      continue
    }
    if (char === '<' && source[index + 1] !== '<') {
      const end = source.indexOf('>', index)
      if (end < 0) break
      const hex = source.slice(index + 1, end).replace(/\s+/g, '')
      const bytes = []
      for (let cursor = 0; cursor < hex.length; cursor += 2) bytes.push(parseInt(hex.slice(cursor, cursor + 2) || '0', 16))
      stack.push({ type: 'string', bytes })
      index = end + 1
      continue
    }
    if (char === '/') {
      let cursor = index + 1
      while (cursor < source.length && /[^\s/[\]<>()]/.test(source[cursor])) cursor += 1
      stack.push({ type: 'name', value: source.slice(index + 1, cursor) })
      index = cursor
      continue
    }
    if (/[0-9.+-]/.test(char)) {
      let cursor = index
      while (cursor < source.length && /[0-9.+-]/.test(source[cursor])) cursor += 1
      stack.push({ type: 'number', value: Number(source.slice(index, cursor)) })
      index = cursor
      continue
    }
    if (/[A-Za-z'"]/.test(char)) {
      let cursor = index
      while (cursor < source.length && /[A-Za-z'"*]/.test(source[cursor])) cursor += 1
      const op = source.slice(index, cursor)
      if (op === 'Tf') {
        const name = stack.filter((item) => item.type === 'name').pop()
        font = name ? fonts.get(name.value) ?? null : null
      } else if (op === 'Tj' || op === "'" || op === '"') {
        const str = stack.filter((item) => item.type === 'string').pop()
        if (str) out.push(decodeChunk(str.bytes, font))
        if (op !== 'Tj') pushNewline()
      } else if (op === 'TJ') {
        for (const item of stack) {
          if (item.type === 'string') out.push(decodeChunk(item.bytes, font))
          else if (item.type === 'number' && item.value < -120) pushSpace()
        }
      } else if (op === 'Td' || op === 'TD' || op === 'T*') {
        const numbers = stack.filter((item) => item.type === 'number')
        if (op === 'T*' || (numbers.length >= 2 && Math.abs(numbers[numbers.length - 1].value) > 0.5)) pushNewline()
      } else if (op === 'ET') {
        pushNewline()
      }
      stack.length = 0
      index = cursor
      continue
    }
    index += 1
  }
  return out
    .join('')
    .replace(/\u0000/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * PDF → 纯文本。加密或取不到文字时抛 E_PDF_UNSUPPORTED。
 */
export function extractPdfText(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? '')
  if (buffer.length < 8 || asLatin1(buffer.subarray(0, 5)) !== '%PDF-') {
    throw unsupported('extractPdfText:header', '%PDF-')
  }
  if (/\/Encrypt\b/.test(asLatin1(buffer))) {
    throw unsupported('extractPdfText:encrypted', '未加密 PDF')
  }

  const objects = parseObjects(buffer)
  if (objects.size === 0) throw unsupported('extractPdfText:objects', 'PDF 对象')

  const pages = [...objects.entries()].filter(([, object]) => /\/Type\s*\/Page\b/.test(object.dict))
  if (pages.length === 0) throw unsupported('extractPdfText:pages', '/Type /Page')

  const chunks = []
  for (const [, page] of pages.slice(0, 20)) {
    const fonts = pageFonts(objects, page.dict)
    const contents = refIds(page.dict, 'Contents')
    if (contents.length === 0) continue
    const content = Buffer.concat(contents.map((ref) => streamOf(objects, ref)))
    if (content.length === 0) continue
    const text = extractContentText(content, fonts)
    if (text !== '') chunks.push(text)
  }

  const text = chunks.join('\n').trim()
  if (text.length < 20) throw unsupported('extractPdfText:text', '文字型 PDF（扫描件请用 docx 或粘贴文本）')
  return text
}
