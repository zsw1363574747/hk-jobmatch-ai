const SOURCE_LABEL = { jd: 'JD 正文', 'search-api': '搜索摘要', teaser: '搜索摘要', manual: '手动粘贴', cache: '缓存' }

function experienceLine(job) {
  const exp = job.experience
  if (!exp || exp.requiredYears === null || exp.requiredYears === undefined) return '经验要求 未提及'
  const range =
    Number.isInteger(exp.minYears) && Number.isInteger(exp.maxYears) && exp.maxYears !== exp.minYears
      ? `${exp.minYears}-${exp.maxYears} 年`
      : `${exp.requiredYears} 年+`
  const industry = exp.industry?.label ? ` · ${exp.industry.label}行业` : ''
  const have = exp.haveYears
  if (have === null || have === undefined) return `经验要求 ${range}${industry}（简历未识别年限）`
  const verdict = exp.verdict === 'meet' ? '达标' : exp.verdict === 'short' ? `差 ${Math.abs(exp.gapYears ?? 0)} 年` : '未知'
  return `经验要求 ${range}${industry} · 你 ${have} 年 · ${verdict}`
}

export function buildMarkdown(data) {
  const lines = []
  lines.push(`# 匹配报告 ${data.runId}`, '')
  lines.push(`- 生成时间：${data.createdAt ?? '—'}`)
  lines.push(`- 关键词：${(data.query?.keywords ?? []).join(' ') || '—'}`)
  if (data.query?.postedWithinWeeks) lines.push(`- 发布时间窗口：${data.query.postedWithinWeeks} 周（超过窗口的岗位保留并标红）`)
  const sources = (data.query?.sourceStats ?? []).map(
    (row) => `${row.label ?? row.id}${row.count != null ? ` ${row.count}` : ''}${row.blocked ? '(被拦)' : ''}`,
  )
  if (sources.length > 0) lines.push(`- 来源：${sources.join(' · ')}`)
  lines.push(
    `- 候选：${data.jobs.length} 条（A ${data.counts.A} · B ${data.counts.B} · C ${data.counts.C} · X ${data.counts.X}）`,
  )
  if (data.weights) {
    const parts = Object.entries(data.weights).map(([key, value]) => `${key} ${Math.round(value * 100)}%`)
    lines.push(`- 权重：${parts.join(' · ')}`)
  }
  if (data.rules?.penalty) lines.push(`- 经验门槛：要求高于简历年限时，分数 ×${data.rules.penalty}`)
  lines.push('')

  const top = data.jobs.slice(0, 10)
  lines.push('## Top 10', '')
  top.forEach((job, index) => {
    lines.push(`### ${index + 1}. ${job.title} — ${job.company || '—'}`)
    lines.push(
      `分数 ${job.score ?? '—'} · ${job.tier ?? '—'} 档 · ${job.sourceLabel || job.source || ''} · ${job.locations.join(' / ') || '—'} · ${job.salaryText || job.salaryLabel || '—'} · ${job.url}`,
    )
    lines.push(`- ${experienceLine(job)}${job.jdSource ? `（JD 来源：${SOURCE_LABEL[job.jdSource] ?? job.jdSource}）` : ''}`)
    if (job.verdict) {
      lines.push(`- 命中：${(job.verdict.reasons ?? []).join('；') || '—'}`)
      lines.push(`- 缺口：${(job.verdict.gaps ?? []).join('；') || '—'}`)
      lines.push(`- 下一步：${job.verdict.nextAction ?? '—'}`)
    } else {
      lines.push('- 命中：（agent 还没写）')
    }
    lines.push('')
  })

  const rest = data.jobs.slice(10)
  if (rest.length > 0) {
    lines.push(`## 其余 ${rest.length} 条`, '')
    for (const job of rest) {
      lines.push(`- ${job.title} — ${job.company || '—'} ${job.url}`)
    }
  }

  return lines.join('\n')
}
