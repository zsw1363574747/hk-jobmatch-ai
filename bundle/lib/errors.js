// 20 个错误码，与 PRD 5.7 逐字一致。code → [message, hint]
const TABLE = Object.freeze({
  E_BAD_PARAM: ['参数不合法', '检查字段类型与必填项'],
  E_RESUME_MISSING: ['没有拿到简历', '给 path 或 text 之一'],
  E_NO_FILE: ['简历文件不存在', '检查简历路径拼写'],
  E_RESUME_FORMAT: ['不支持的简历格式', '用 .txt/.md/.docx 或粘贴文本'],
  E_RESUME_TOO_SHORT: ['简历正文太短', '简历正文至少 80 字'],
  E_PDF_UNSUPPORTED: ['暂不支持 PDF', '用 Word/WPS 另存为 .docx，或直接粘贴文本'],
  E_DOCX_CORRUPT: ['docx 解不开', '文件可能损坏，另存一次再试'],
  E_LEXICON_BAD: ['技能词典无法解析', '检查 data/lexicon.json 是否合法 JSON'],
  E_NO_KEYWORDS: ['没有关键词', '至少给一个关键词'],
  E_NETWORK: ['请求 jobsdb 失败', '检查网络，断网时不重试'],
  E_HTTP_STATUS: ['jobsdb 返回异常状态', '稍后重试；连续失败看是否触发了限流'],
  E_TIMEOUT: ['请求超时', '超 15 s 未返回，缩短关键词或稍后重试'],
  E_RATE_LIMIT: ['请求过快被限流', '等 60 s，或减少页数与详情条数'],
  E_EMPTY_RESULT: ['搜索没有结果', '换更宽的关键词'],
  E_PARSE_FAILED: ['岗位页解析失败', 'jobsdb 页面结构可能已变，需更新解析'],
  E_JOB_GONE: ['岗位已下架', '跳过这条即可'],
  E_RUN_NOT_FOUND: ['找不到这次运行', '先跑一次 search'],
  E_VERDICT_BAD: ['复排结果不合法', 'verdict 需含 id/fit/tier/reasons(≥2)/gaps(≥1)'],
  E_WRITE_FAILED: ['写入失败', '检查 data/ 写权限与磁盘空间'],
  E_INTERNAL: ['内部错误', '带原始 message，按 bug 记录'],
})

export const ERROR_CODES = Object.freeze(Object.keys(TABLE))

/**
 * 构造统一错误对象。detail 只允许放 step / expected，不放原始输入。
 */
export function fail(code, detail = {}) {
  const entry = TABLE[code] ?? TABLE.E_INTERNAL
  const error = { ok: false, code: TABLE[code] ? code : 'E_INTERNAL', message: entry[0], hint: entry[1] }
  if (detail.step) error.step = detail.step
  if (detail.expected) error.expected = detail.expected
  return error
}

/**
 * 把任意异常归一成 { ok:false, code, message, hint }，不回显简历内容。
 */
export function toError(err) {
  if (err && typeof err.code === 'string' && Object.hasOwn(TABLE, err.code)) {
    return fail(err.code, { step: err.step, expected: err.expected })
  }
  const raw = err && typeof err.message === 'string' ? err.message : String(err)
  const result = fail('E_INTERNAL')
  result.message = raw.slice(0, 200)
  return result
}
