import {
  $,
  JOB_SOURCE_LABEL,
  SOURCE_LABEL,
  api,
  escapeHtml,
  jobKey,
  setMsg,
  state,
  titleOf,
} from './core.js'
import { experienceNote, renderRows, salarySourceLabel, updateCounts } from './results.js'
import { applyWeights } from './weights.js'
import { markViewed } from './viewed.js'

/** JD 里像「公司介绍」的小标题。 */
const COMPANY_BLOCK_RE =
  /^(about(\s+(us|the\s+(company|team|business)))?|company(\s+(overview|profile|background|introduction))?|our\s+(client|company)|background|who\s+we\s+are|the\s+company|公司簡介|公司背景|關於我們|关于我们|集團簡介|集团简介)/i
/** 正文进入「职责 / 要求」的标志，兜底取开头段落时遇到就停。 */
const INTRO_STOP_RE =
  /^(job\s+responsibilit|responsibilit|job\s+(duties|description)|duties|what\s+you[’']?ll\s+(be\s+doing|do)|what\s+to\s+expect|the\s+role|your\s+role|requirements?|qualifications?|skills|job\s+highlights|職責|职责|工作內容|工作内容|要求|入職要求|职位要求|職位要求)/i
/** 抬头就是编号/引用号的段落（政府站职位卡常见），不算公司介绍，跳过。 */
const INTRO_NOISE_RE = /^(no\.?\s*[:：]|ref(erence)?\s*[:：.]|job\s+no|position\s+no|職位編號|职位编号|編號)/i

export function companyIntro(text) {
  const blocks = String(text ?? '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
  const about = blocks.filter((block) => COMPANY_BLOCK_RE.test(block))
  if (about.length > 0) return about.slice(0, 2).join('\n\n').slice(0, 1200)

  const lead = []
  for (const block of blocks) {
    if (INTRO_STOP_RE.test(block)) break
    if (INTRO_NOISE_RE.test(block)) continue
    if (/^[•·*\-–—]\s/.test(block)) break
    lead.push(block)
    if (lead.join('\n\n').length >= 600) break
  }
  const head = lead.join('\n\n').trim()
  return head.length >= 40 ? head.slice(0, 600) : ''
}

export async function fetchDetail(job) {
  if (state.detailLoaded.has(jobKey(job))) return job
  const result = await api('/api/jobs', { body: { runId: state.run.runId, ids: [jobKey(job)], sort: false } })
  if (!result.ok) {
    setMsg('runMsg', `${result.code}：${result.hint ?? result.message}`, 'error')
    return job
  }
  state.detailLoaded.add(jobKey(job))
  if (Array.isArray(result.ranked) && result.ranked.length > 0) {
    state.run = {
      ...state.run,
      jobs: result.ranked,
      counts: result.counts ?? state.run.counts,
      weights: result.weights ?? state.run.weights,
      rules: result.rules ?? state.run.rules,
    }
    renderRows(result.ranked)
    updateCounts(result.counts ?? state.run.counts)
  }
  return (state.run.jobs ?? []).find((item) => jobKey(item) === jobKey(job)) ?? job
}

function preciseRowHtml() {
  const disabled = state.loggedIn ? '' : 'disabled'
  const title = state.loggedIn
    ? '用登录态和「Salary match」标记二分岗位薪资；会临时改你的期望薪资，跑完自动恢复'
    : '先点「过人工验证」登录 jobsdb'
  return `<p class="precise-row"><button type="button" class="ghost small" id="preciseBtn" ${disabled} title="${escapeHtml(title)}">精确薪资</button><span class="hint" id="preciseNote"></span></p>`
}

export function salarySectionHtml(job) {
  const salary = job.salary ?? null
  if (!salary) {
    const canProbe = job.source === 'jobsdb'
    return `<h4>薪资 <span class="badge warn" id="salaryBadge">未披露</span></h4>
      <p class="salary-line" id="salaryLine">—</p>
      <p class="hint" id="salaryNote">${canProbe ? 'JD 没写薪资。点开这条时会自动用平台的薪资筛选反推（约 3–5 秒）。' : 'JD 没写薪资；CTgoodjobs 没有薪资筛选探针，只能以 JD 原文为准。'}</p>
      ${preciseRowHtml()}`
  }
  const badgeClass = salary.kind === 'explicit' ? 'ok' : 'warn'
  const note = salary.kind === 'explicit'
    ? (salary.bonus ? `花红：${salary.bonus}（不计入上面的月薪）` : '来自 JD 原文，未做换算。')
    : `平台筛选反推：命中 ${(salary.evidence?.bands ?? []).join('、')} 档；命中区间向外多一档，已扣回 5k。`
  const matchLine = salary.expectedSalaryMatch === true
    ? '<p class="hint ok">✓ 与你的期望薪资相符（平台标记）</p>'
    : salary.expectedSalaryMatch === false
      ? '<p class="hint">与你的期望薪资不符（平台标记）</p>'
      : ''
  return `<h4>薪资 <span class="badge ${badgeClass}" id="salaryBadge">${escapeHtml(salarySourceLabel(salary))}</span></h4>
    <p class="salary-line" id="salaryLine">${escapeHtml(job.salaryText || '')}${salary.kind === 'explicit' ? '' : ' <em class="est">估</em>'}${salary.openEnded ? ' <span class="hint">（60k 以上不再细分）</span>' : ''}</p>
    <p class="hint" id="salaryNote">${escapeHtml(note)}</p>
    <div id="salaryMatch">${matchLine}</div>
    ${preciseRowHtml()}`
}

export async function autoProbeSalary(job) {
  if (!state.run?.runId || !job) return
  const line = $('salaryLine')
  const note = $('salaryNote')
  const badge = $('salaryBadge')
  if (!line) return
  if (badge) {
    badge.className = 'badge'
    badge.textContent = '探针中'
  }
  line.textContent = '正在用平台薪资筛选反推…'
  try {
    const result = await api('/api/salary', { body: { runId: state.run.runId, key: jobKey(job) } })
    if (!result.ok) {
      if (badge) {
        badge.className = 'badge warn'
        badge.textContent = '未披露'
      }
      line.textContent = '—'
      note.textContent = result.code === 'E_NO_BAND_HIT'
        ? '平台的薪资筛选也没探到（这家公司可能没填薪资）。'
        : `${result.code}：${result.message ?? ''}`
      return
    }
    const salary = result.salary
    const updated = (state.run.jobs ?? []).find((item) => jobKey(item) === jobKey(job))
    if (updated) {
      updated.salary = salary
      updated.salaryText = result.salaryText ?? updated.salaryText
    }
    state.activeJob = updated ?? job
    if (badge) {
      badge.className = 'badge warn'
      badge.textContent = salarySourceLabel(salary)
    }
    line.innerHTML = `${escapeHtml(result.salaryText || '')} <em class="est">估</em>${salary.openEnded ? ' <span class="hint">（60k 以上不再细分）</span>' : ''}`
    const meta = $('detailSalaryMeta')
    if (meta) meta.textContent = result.salaryText || ''
    const box = $('salaryMatch')
    if (box) {
      box.innerHTML = salary.expectedSalaryMatch === true
        ? '<p class="hint ok">✓ 与你的期望薪资相符（平台标记）</p>'
        : salary.expectedSalaryMatch === false
          ? '<p class="hint">与你的期望薪资不符（平台标记）</p>'
          : ''
    }
    note.textContent = result.cached
      ? `平台筛选反推（缓存）：命中 ${(result.bands ?? []).join('、')} 档；命中区间向外多一档，已扣回 5k。`
      : `平台筛选反推：命中 ${(result.bands ?? []).join('、')} 档（${result.probes ?? 0} 次查询）；命中区间向外多一档，已扣回 5k。`
    renderRows(state.run.jobs ?? [])
  } catch (error) {
    if (badge) {
      badge.className = 'badge warn'
      badge.textContent = '未披露'
    }
    line.textContent = '—'
    note.textContent = `探针失败：${String(error?.message ?? error)}`
  }
}

export async function openDetail(job) {
  state.activeId = jobKey(job)
  state.activeJob = job
  markViewed(jobKey(job))
  for (const tr of $('rows').querySelectorAll('tr')) {
    tr.classList.toggle('active', tr.dataset.id === jobKey(job))
  }
  const card = $('detail')
  card.innerHTML = '<p class="hint">加载中…</p>'

  const current = await fetchDetail(job)
  state.activeJob = current

  const verdict = current.verdict
  const runHasVerdict = (state.run?.jobs ?? []).some((item) => item.verdict)
  const verdictCount = (state.run?.jobs ?? []).filter((item) => item.verdict).length
  const placeholder = !state.profile && !runHasVerdict
    ? '（需要简历画像：先解析简历再搜索）'
    : runHasVerdict
      ? `（这条还没复排：本次只写了前 ${verdictCount} 条）`
      : '（这条还没复排：agent 尚未运行，规则分只是初筛）'

  const intro = current.source === 'jobsdb' ? companyIntro(current.contentText) : ''
  const jd = String(current.contentText ?? '').trim()
  const salaryObj = current.salary ?? null
  const salaryText = current.salaryText || (typeof current.salaryLabel === 'string' ? current.salaryLabel : '')
  const salary = salaryObj ? salaryText : (salaryText || '薪资未标注')
  const listed = (current.listedAt ?? '').slice(0, 10)
  const profile = current.companyProfile ?? null
  const expText = experienceNote(current)
  const jdSource = current.jdSource ? SOURCE_LABEL[current.jdSource] ?? current.jdSource : '未抓取'
  const jdBanner =
    current.jdSource === 'teaser' || current.jdSource === 'search-api'
      ? `<p class="hint warn">岗位页被 Cloudflare 拦住，只拿到搜索摘要（${current.contentChars ?? jd.length} 字），不是 JD 正文；可点「粘贴 JD」手动补齐。</p>`
      : ''

  const facts = [
    ['岗位', current.title ?? '—'],
    ['公司', current.company ?? '—'],
    ['经验要求', expText],
    ['地点', (current.locations ?? []).join(' / ') || current.location || '—'],
    ['发布', listed || '—'],
    ['工作类型', (current.workTypes ?? []).join(' / ') || '—'],
    ['职位分类', (current.classifications ?? []).join(' / ') || '—'],
  ]
  if (profile?.industry) facts.push(['行业', profile.industry])
  if (profile?.size) facts.push(['规模', profile.size])
  const background = profile?.description || intro
  const sourceName = JOB_SOURCE_LABEL[current.source] ?? current.source ?? 'JobsDB'
  card.innerHTML = `
    <div class="detail-head">
      <p class="meta src-line">来源：${escapeHtml(sourceName)}</p>
      <h3>${escapeHtml(titleOf(current))}</h3>
      ${state.lang === 'zh' && state.translations[current.id] ? `<p class="meta">原文：${escapeHtml(current.title)}</p>` : ''}
      <p class="meta">${escapeHtml(current.company ?? '')} · ${escapeHtml((current.locations ?? []).join(' / ') || '地点未标注')} · <span id="detailSalaryMeta">${escapeHtml(salary)}</span>${listed ? ` · 发布 ${escapeHtml(listed)}` : ''} · <a href="${current.url ?? '#'}" target="_blank" rel="noreferrer">打开原岗位</a></p>
    </div>
    <div class="detail-scroll">
      <section class="dsec">
        <h4>公司 / 岗位概览</h4>
        <dl class="facts">${facts.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>
      </section>
      <section class="dsec" id="salarySec">
        ${salarySectionHtml(current)}
      </section>
      <section class="dsec">
        <h4>${profile?.name ? `公司背景 · ${escapeHtml(profile.name)}` : intro ? '公司背景 <span class="hint">（雇主没填档案，这段摘自 JD 开头）</span>' : '公司背景'}</h4>
        ${profile?.logo ? `<img class="company-logo" src="${escapeHtml(profile.logo)}" alt="">` : ''}
        <p id="bgText">${background ? escapeHtml(background) : '这条 JD 没有公司介绍段落；上方是招聘页字段，可点「打开原岗位 / 公司主页」自己看。'}</p>
        <p class="hint" id="bgNote"></p>
        ${profile?.website ? `<p class="meta">官网：<a href="${escapeHtml(profile.website)}" target="_blank" rel="noreferrer">${escapeHtml(profile.website)}</a></p>` : ''}
        ${profile?.url ? `<p class="meta"><a href="${escapeHtml(profile.url)}" target="_blank" rel="noreferrer">公司主页（jobsdb）</a></p>` : ''}
      </section>
      <section class="dsec">
        <h4>公司新闻 <span class="hint" id="newsState">检索中…</span></h4>
        <p class="hint">优先显示「人事变动 / 公司发展」类新闻，其余按时间倒序</p>
        <div id="newsList" class="news-list"><p class="hint">正在搜最近新闻…</p></div>
      </section>
      <section class="dsec">
        <h4>岗位 JD <span class="badge ${current.jdSource === 'jd' || current.jdSource === 'manual' ? 'ok' : 'warn'}">${escapeHtml(jdSource)}</span> <span class="hint" id="jdNote"></span>
          <button class="ghost small" id="pasteToggle" type="button">粘贴 JD</button></h4>
        ${jdBanner}
        <div class="jd-text" id="jdText">${jd ? escapeHtml(jd) : '（还没抓详情）'}</div>
        <div class="paste-box" id="pasteBox" hidden>
          <textarea id="jdPaste" rows="6" placeholder="把 jobsdb 页面上的 JD 正文整段粘进来（≥ 20 字）。保存后会重算经验要求与分数。"></textarea>
          <div class="row"><button class="primary small" id="jdSave" type="button">保存并重算</button><button class="ghost small" id="jdCancel" type="button">取消</button></div>
        </div>
      </section>
      <section class="dsec">
        <h4>复排</h4>
        <div class="grid3">
          <div class="box good"><h4>命中</h4><ul>${(verdict?.reasons ?? [placeholder]).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
          <div class="box gap"><h4>缺口</h4><ul>${(verdict?.gaps ?? [placeholder]).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
          <div class="box next"><h4>下一步</h4><ul><li>${escapeHtml(verdict?.nextAction ?? placeholder)}</li></ul></div>
        </div>
      </section>
    </div>`
  bindPaste(current)
  bindPrecise(current)
  loadNews(current.company ?? profile?.name ?? '')
  if (!current.salary && current.source === 'jobsdb') autoProbeSalary(current)
  if (state.lang === 'zh') {
    await translateSection(current, 'background')
    await translateSection(current, 'jd')
  }
}

export function bindPrecise(job) {
  const btn = $('preciseBtn')
  if (!btn) return
  btn.addEventListener('click', () => runPrecise(job))
}

async function runPrecise(job) {
  const btn = $('preciseBtn')
  const note = $('preciseNote')
  if (!state.loggedIn) {
    if (note) note.textContent = '先登录 jobsdb 才能用'
    return
  }
  const ok = confirm('会用你的 JobsDB 账号临时修改「期望薪资」，反复十几到二十几次来二分岗位薪资，约 3–6 分钟；结束后自动恢复原值。继续？')
  if (!ok) return

  const label = btn.textContent
  btn.disabled = true
  btn.textContent = '二分中…'
  if (note) note.textContent = '正在二分：每次约 10 秒，期间会临时改期望薪资，请勿关闭服务窗口…'

  const res = await api('/api/salary-precise', { body: { runId: state.run.runId, key: jobKey(job) } })
  btn.disabled = false
  btn.textContent = label

  if (!res.ok) {
    if (note) note.textContent = `${res.code}：${res.message ?? ''}`
    return
  }

  const updated = (state.run.jobs ?? []).find((item) => jobKey(item) === jobKey(job))
  if (updated) {
    updated.salary = res.salary
    updated.salaryText = res.salaryText
    state.activeJob = updated
  }
  const badge = $('salaryBadge')
  if (badge) {
    badge.className = 'badge ok'
    badge.textContent = '平台匹配'
  }
  const line = $('salaryLine')
  if (line) line.innerHTML = `${escapeHtml(res.salaryText)} <em class="est">精确</em>`
  const salaryNote = $('salaryNote')
  if (salaryNote) {
    salaryNote.textContent = `二分 ${res.checks} 次（约 1,000 HKD/年精度）；徽章区间边界就是岗位薪资的上下限。`
  }
  const meta = $('detailSalaryMeta')
  if (meta) meta.textContent = res.salaryText
  if (note) {
    note.textContent = res.restored === false
      ? (res.restoreError ?? '原期望薪资没恢复，请到 JobsDB 资料页手动改回')
      : '完成，已恢复原期望薪资'
  }
  renderRows(state.run.jobs ?? [])
}

export function bindPaste(job) {  const toggle = $('pasteToggle')
  const box = $('pasteBox')
  if (!toggle || !box) return
  toggle.addEventListener('click', () => {
    box.hidden = !box.hidden
  })
  $('jdCancel')?.addEventListener('click', () => {
    box.hidden = true
  })
  $('jdSave')?.addEventListener('click', async () => {
    const text = ($('jdPaste')?.value ?? '').trim()
    if (text.length < 20) {
      setMsg('runMsg', 'JD 正文太短（至少 20 字）', 'error')
      return
    }
    const result = await api('/api/jd', { body: { runId: state.run.runId, id: job.id, text } })
    if (!result.ok) {
      setMsg('runMsg', `${result.code}：${result.hint ?? result.message}`, 'error')
      return
    }
    const updated = (state.run.jobs ?? []).find((item) => String(item.id) === String(job.id)) ?? job
    if (result.job) Object.assign(updated, result.job)
    updated.contentText = text
    updated.jdSource = 'manual'
    state.detailLoaded.add(String(job.id))
    renderRows(state.run.jobs)
    updateCounts(result.counts ?? state.run.counts)
    setMsg('runMsg', 'JD 已保存，经验与分数已重算', 'ok')
    await openDetail(updated)
  })
}

export async function translateSection(job, field) {
  const textEl = $(field === 'jd' ? 'jdText' : 'bgText')
  const noteEl = $(field === 'jd' ? 'jdNote' : 'bgNote')
  if (!textEl || !noteEl) return
  const original = textEl.textContent
  if (!original || original.startsWith('这条 JD 没有公司介绍段落') || original.startsWith('（还没抓详情）')) return
  noteEl.textContent = '翻译中…'
  const result = await api('/api/translate', { body: { runId: state.run.runId, jobId: job.id, field } }).catch(() => null)
  if (!result || !result.ok) {
    noteEl.textContent =
      result?.code === 'E_NETWORK'
        ? '翻译服务连不上（离线），显示原文'
        : `翻译失败（${result?.code ?? 'E_NETWORK'}），显示原文；可点右上「原文 → 中文」重试`
    return
  }
  if (result.missing === 'detail') {
    noteEl.textContent = ''
    return
  }
  if (!result.text) {
    noteEl.textContent = ''
    return
  }
  textEl.textContent = result.text
  noteEl.textContent = result.cached ? '机器翻译 · 缓存' : '机器翻译'
}

export async function loadNews(company) {
  const box = $('newsList')
  const stateEl = $('newsState')
  if (!box) return
  if (!company) {
    box.innerHTML = '<p class="hint">这条岗位没有公司名，无法检索新闻</p>'
    if (stateEl) stateEl.textContent = ''
    return
  }
  if (state.newsCache[company]) {
    renderNews(box, state.newsCache[company])
    if (stateEl) stateEl.textContent = ''
    return
  }
  const result = await api(`/api/news?company=${encodeURIComponent(company)}`, { method: 'GET' }).catch(() => null)
  if (!result || !result.ok) {
    box.innerHTML = `<p class="hint">新闻源连不上（${escapeHtml(result?.code ?? 'E_NETWORK')}），这次先不看新闻</p>`
    if (stateEl) stateEl.textContent = ''
    return
  }
  state.newsCache[company] = result
  if (stateEl) stateEl.textContent = ''
  renderNews(box, result)
}

export function renderNews(box, data) {
  const items = data.items ?? []
  if (items.length === 0) {
    box.innerHTML = '<p class="hint">最近没搜到点名提到这家公司的新闻</p>'
    return
  }
  box.innerHTML = items
    .map((item) => {
      const tags = (item.tags ?? []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')
      const badge = item.match === 'name' ? '<span class="tag name">点名</span>' : ''
      return `<div class="news-item"><a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a><div class="news-meta">${escapeHtml(item.date ?? '')}${item.source ? ` · ${escapeHtml(item.source)}` : ''} ${badge}${tags}</div></div>`
    })
    .join('')
}

/** 用详情结果刷新列表：保留分数与排序，同时更新计数。 */
export function mergeDetailResult(res) {
  if (!res?.ok || !Array.isArray(res.ranked)) return
  state.run = {
    ...state.run,
    jobs: res.ranked,
    counts: res.counts ?? state.run.counts,
    weights: res.weights ?? state.run.weights,
    rules: res.rules ?? state.run.rules,
  }
  renderRows(res.ranked)
  updateCounts(res.counts ?? state.run.counts)
}

/**
 * 搜索后持续解析所有岗位的 JD（分批），直到没有「未提及」为止。
 * 详情命令现在不再重算分数，所以这里只更新经验列和正文；排序等用户显式重排。
 */
export async function hydrateDetails() {
  const run = state.run
  if (!run?.runId) return
  const keys = (run.jobs ?? []).filter((job) => (job.contentChars ?? 0) === 0).map((job) => jobKey(job))
  if (keys.length === 0) return
  const chunkSize = 8
  let done = 0
  for (let index = 0; index < keys.length; index += chunkSize) {
    if (state.run?.runId !== run.runId) return
    const chunk = keys.slice(index, index + chunkSize)
    setMsg('runMsg', `正在解析 JD：${done}/${keys.length} 条…`)
    try {
      const res = await api('/api/jobs', { body: { runId: run.runId, ids: chunk, parallel: 6, withProfile: false } })
      mergeDetailResult(res)
      done += chunk.length
    } catch (error) {
      setMsg('runMsg', `解析中断（${error?.message ?? '未知错误'}）：已完成 ${done}/${keys.length}`, 'error')
      return
    }
  }
  const left = (state.run?.jobs ?? []).filter((job) => (job.contentChars ?? 0) === 0).length
  // 详情解析完成后显式重排一次：让真实 JD 年限/技能进入分数。
  // 点开单条详情仍然不会重排，只有这里（搜索后的批量补全）会。
  if (state.run?.runId === run.runId && done > 0) {
    await applyWeights({ silent: true })
  }
  setMsg(
    'runMsg',
    left > 0
      ? `已解析 ${keys.length - left}/${keys.length} 条 JD，其余只拿到搜索摘要（点开可重试）`
      : `已解析全部 ${keys.length} 条 JD，已按匹配规则自动重排`,
    left > 0 ? 'hint' : 'ok',
  )
}
