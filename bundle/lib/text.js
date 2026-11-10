const ENTITIES = Object.freeze({
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
})

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (match) => ENTITIES[match] ?? match)
}

/**
 * jobsdb 页面的 JD 正文是 HTML；这里按 5.6.1 的步骤转纯文本。
 */
export function htmlToText(html) {
  let text = String(html ?? '')
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  text = text
    .replace(/<\/(p|li|div|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)

  const lines = text.split(/\r?\n/).map((line) => line.replace(/[ \t]+$/g, '').trim())
  const kept = []
  let blank = false
  for (const line of lines) {
    if (line === '') {
      if (!blank && kept.length > 0) {
        kept.push('')
        blank = true
      }
      continue
    }
    kept.push(line)
    blank = false
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  return kept.join('\n')
}
