import {
  $,
  INDUSTRY_FROM,
  SALARY_SOURCE_LABEL,
  SOURCE_LABEL,
  emit,
  escapeHtml,
  jobKey,
  setMsg,
  state,
  titleOf,
} from './core.js'
import { isFresh, isViewed } from './viewed.js'

export function tierClass(tier) {
  return tier === 'A' ? 'a' : tier === 'B' ? 'b' : tier === 'C' ? 'c' : 'x'
}

export function salarySourceLabel(salary) {
  if (!salary) return ''
  return SALARY_SOURCE_LABEL[salary.source] ?? salary.source ?? ''
}

/** 岗位发布了多少天；没有 listedAt 返回 null（未知，不标红）。 */
export function postedAgeDays(job, now = Date.now()) {
  const published = Date.parse(job?.listedAt ?? '')
  if (!Number.isFinite(published)) return null
  return (now - published) / 86400000
}

/** 是否超过用户设置的「发布时间（周内）」窗口。 */
export function isPostedStale(job, weeks = state.postedWithinWeeks) {
  const days = postedAgeDays(job)
  if (days === null) return false
  return days > Math.max(1, Number(weeks) || 4) * 7
}

export function salaryTitle(salary) {
  if (!salary) return ''
  const parts = []
  if (salary.source === 'platform-filter') {
    parts.push(`平台薪资筛选反推${salary.evidence?.bands ? `：命中 ${salary.evidence.bands.join('、')} 档` : ''}`)
  } else if (salary.source === 'benchmark') {
    parts.push('按同族岗位基准推断')
  } else {
    parts.push(`JD 原文${salary.label ? `：${salary.label}` : ''}`)
  }
  if (salary.bonus) parts.push(`花红：${salary.bonus}`)
  if (salary.period && salary.period !== 'month') parts.push(`原周期：${salary.period}`)
  return parts.join(' · ')
}

export function experienceCell(job) {
  const exp = job.experience
  if (!exp || exp.requiredYears === null || exp.requiredYears === undefined) {
    if ((job.contentChars ?? 0) > 0) {
      return '<span class="exp unknown" title="JD 已抓取，但正文没有写年限要求">未写明</span>'
    }
    return '<span class="exp pending" title="JD 还没抓，后台正在解析">未解析</span>'
  }
  const isRange = Number.isInteger(exp.minYears) && Number.isInteger(exp.maxYears) && exp.maxYears !== exp.minYears
  const range = isRange ? `${exp.minYears}-${exp.maxYears} 年` : `${exp.requiredYears} 年+`
  const verdict = exp.verdict === 'meet' ? 'meet' : exp.verdict === 'short' ? 'short' : 'unknown'
  const industry = exp.industry
  const industryText = industry?.label ? ` · ${industry.label}行业` : ''
  const detail =
    exp.haveYears === null || exp.haveYears === undefined
      ? `要求 ${range}${industryText}`
      : `要求 ${range}${industryText} · 你 ${exp.haveYears} 年${verdict === 'short' ? ` · 差 ${Math.abs(exp.gapYears ?? 0)} 年` : verdict === 'meet' ? ' · 达标' : ''}`
  const mark = verdict === 'short' ? '<i class="expflag" title="经验不达标，整体降分">↓</i>' : ''
  const where = industry?.phrase ? `（${INDUSTRY_FROM[industry.source] ?? '推断'}：${industry.phrase}）` : ''
  const domain = industry?.label
    ? `<em class="expdomain" title="${escapeHtml(`经验所属行业${where}`)}">${escapeHtml(industry.label)}</em>`
    : ''
  return `<span class="exp ${verdict}" title="${escapeHtml(detail)}">${range}</span>${mark}${domain}`
}

export function experienceNote(job) {
  const exp = job.experience
  if (!exp || exp.requiredYears === null || exp.requiredYears === undefined) return '未提及'
  const isRange = Number.isInteger(exp.minYears) && Number.isInteger(exp.maxYears) && exp.maxYears !== exp.minYears
  const range = isRange ? `${exp.minYears}-${exp.maxYears} 年` : `${exp.requiredYears} 年+`
  const src = exp.known ? `（${SOURCE_LABEL[exp.source] ?? exp.source}）` : ''
  const industry = exp.industry?.label
    ? ` · ${exp.industry.label}行业${exp.industry.phrase ? `（${INDUSTRY_FROM[exp.industry.source] ?? '推断'}：${exp.industry.phrase}）` : ''}`
    : ' · 行业未提及'
  if (exp.haveYears === null || exp.haveYears === undefined) return `${range}${industry}${src}`
  const verdict = exp.verdict === 'short' ? `差 ${Math.abs(exp.gapYears ?? 0)} 年` : exp.verdict === 'meet' ? '达标' : '未知'
  return `${range}${industry}${src} · 你 ${exp.haveYears} 年 · ${verdict}`
}

export function renderRows(jobs) {
  const body = $('rows')
  body.innerHTML = ''
  if (!jobs || jobs.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">没有匹配，换个关键词</td></tr>'
    return
  }
  jobs.forEach((job, index) => {
    const tr = document.createElement('tr')
    tr.dataset.id = jobKey(job)
    if (String(state.activeId) === jobKey(job)) tr.className = 'active'
    const salaryTag = job.salaryText
      ? `<span class="sal ${escapeHtml(job.salary?.kind ?? '')}" title="${escapeHtml(salaryTitle(job.salary))}">${escapeHtml(job.salaryText)}</span>`
      : '<span class="sal none">—</span>'
    const stale = isPostedStale(job)
    const posted = (job.listedAt ?? '').slice(0, 10)
    const companyTitle = stale
      ? `发布时间 ${posted}，超过 ${state.postedWithinWeeks} 周`
      : posted
        ? `发布时间 ${posted}`
        : '发布时间未标注'
    const company = job.company
      ? `<span class="company${stale ? ' company-stale' : ''}" title="${escapeHtml(companyTitle)}">${escapeHtml(job.company)}</span>`
      : ''
    const fresh = isFresh(job)
    const seen = isViewed(jobKey(job))
    const badges = `${fresh ? '<span class="tag new" title="发布时间不到 3 天">新</span>' : ''}${seen ? '<span class="tag seen" title="你点开过这条">已看</span>' : ''}`
    tr.innerHTML = `
      <td class="rank">${String(index + 1).padStart(2, '0')}</td>
      <td class="score">${job.score ?? '—'}${job.verdict ? ' <span class="marker" title="已复排">✓</span>' : ''}</td>
      <td><span class="tier ${tierClass(job.tier)}">${job.tier ?? '—'}</span></td>
      <td class="exp-cell">${experienceCell(job)}</td>
      <td class="sal-cell">${salaryTag}</td>
      <td class="title"><div class="job-title">${badges}${escapeHtml(titleOf(job))}</div><div class="job-sub">${company}${job.locations?.[0] ? ` · ${escapeHtml(job.locations[0])}` : ''}</div></td>`
    tr.addEventListener('click', () => emit('open-job', job))
    body.appendChild(tr)
  })
}

export function updateCounts(counts = {}) {
  counts = counts ?? {}
  const total = (state.run?.jobs ?? []).length
  $('counts').textContent = `共 ${total} 条 · A ${counts.A ?? 0} · B ${counts.B ?? 0} · C ${counts.C ?? 0} · X ${counts.X ?? 0}`
}

export function applyRun(run, { message } = {}) {
  state.run = run
  const weeks = Number(run?.query?.postedWithinWeeks)
  if (Number.isFinite(weeks) && weeks >= 1) state.postedWithinWeeks = Math.min(52, Math.round(weeks))
  const postedInput = $('postedWithin')
  if (postedInput) postedInput.value = String(state.postedWithinWeeks)
  renderRows(run.jobs)
  updateCounts(run.counts ?? {})
  if (message) setMsg('runMsg', message, 'ok')
  // 换了一轮：上一轮生成的 report.md 链接必须作废，否则「打开报告」会打开旧报告。
  // 去掉 href 后下次点击会重新生成（不置 disabled，a.disabled 会吃掉点击）。
  const reportLink = $('reportLink')
  if (reportLink) reportLink.removeAttribute('href')
  emit('run-applied', run)

  const params = new URLSearchParams(location.search)
  const jobParam = params.get('job')
  const target = jobParam
    ? run.jobs.find((job) => jobKey(job) === jobParam || String(job.id) === jobParam)
    : params.has('open')
      ? run.jobs[0]
      : null
  if (target) emit('open-job', target)
}
