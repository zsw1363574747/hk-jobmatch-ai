import {
  $,
  JOB_SOURCE_LABEL,
  api,
  bus,
  escapeHtml,
  jobKey,
  parseList,
  setMsg,
  state,
  token,
} from './js/core.js'
import { applyRun, renderRows, updateCounts } from './js/results.js'
import { hydrateDetails, openDetail } from './js/detail.js'
import { chips, initResume, restoreProfile } from './js/resume.js'
import { applyWeights, currentWeights, initWeights, rememberYears, setWeightsFromRun, yearsOverride } from './js/weights.js'
import { initSalaryReport } from './js/salary-report.js'

/* ---------- 最近运行 / 来源 / 登录态 ---------- */

async function loadRuns() {
  const data = await api('/api/runs', { method: 'GET' })
  const box = $('runs')
  box.innerHTML = ''
  if (!data.ok || (data.runs ?? []).length === 0) {
    box.innerHTML = '<span class="hint">—</span>'
    return
  }
  for (const run of data.runs.slice(0, 5)) {
    const span = document.createElement('span')
    span.className = 'run'
    const counts = run.counts ? ` · A${run.counts.A}/B${run.counts.B}/C${run.counts.C}` : ''
    span.textContent = `${run.runId} · ${(run.keywords ?? []).join(' ') || '—'}${counts}`
    box.appendChild(span)
  }
}

async function loadSources() {
  const data = await api('/api/sources', { method: 'GET' }).catch(() => null)
  if (!data?.ok) {
    $('srcRows').innerHTML = '<span class="hint">读取失败，刷新页面重试</span>'
    return
  }
  const box = $('srcRows')
  box.innerHTML = ''
  for (const item of data.sources ?? []) {
    const row = document.createElement('label')
    row.className = `srcrow${item.available ? '' : ' off'}`
    const checked = state.sources.includes(item.id) ? 'checked' : ''
    const kind = item.needsBrowser ? '浏览器' : 'HTTP'
    row.innerHTML = `<input type="checkbox" data-id="${item.id}" ${checked}${item.available ? '' : ' disabled'}>
      <span class="srcname">${escapeHtml(item.label)}</span>
      <span class="srckind">${kind}</span>`
    row.title = item.note ?? item.label
    box.appendChild(row)
    row.querySelector('input').addEventListener('change', (event) => {
      const id = event.target.dataset.id
      if (event.target.checked) {
        if (!state.sources.includes(id)) state.sources.push(id)
      } else {
        state.sources = state.sources.filter((entry) => entry !== id)
      }
      if (state.sources.length === 0) {
        state.sources = (data.sources ?? []).map((item) => item.id)
        for (const input of box.querySelectorAll('input')) input.checked = true
      }
      $('srcHint').textContent = `已选 ${state.sources.length} 个来源`
    })
  }
  $('srcHint').textContent = `已选 ${state.sources.length} 个来源`
}

/* ---------- 地点选择（JobsDB location label，可多选） ---------- */

let locationDraft = new Set()

function locationItem(value) {
  for (const group of state.locationGroups ?? []) {
    const found = (group.items ?? []).find((item) => item.value === value)
    if (found) return found
  }
  return null
}

function locationText(selected) {
  const list = Array.isArray(selected) ? selected : []
  if (list.length === 0) return '全港'
  if (list.length === 1) return locationItem(list[0])?.zh ?? list[0]
  return `已选 ${list.length} 个地点`
}

function syncLocationLabel() {
  const node = $('locText')
  if (node) {
    node.textContent = locationText(state.locations)
    node.title = (state.locations ?? []).join(' / ')
  }
  $('locBtn')?.classList.toggle('has-value', (state.locations ?? []).length > 0)
}

function renderLocationGroups() {
  const box = $('locGroups')
  if (!box) return
  const groups = state.locationGroups ?? []
  if (groups.length === 0) {
    const code = state.locationError || 'E_NETWORK'
    const stale = code === 'E_NOT_FOUND' || code === 'E_UI_TOKEN'
    const reason = stale
      ? '后台还是改代码前启动的旧进程（新接口没注册）。关掉 start.cmd 窗口、重新双击打开，再刷新本页。'
      : '点「重试」；还不行就看 start.cmd 窗口里的报错。'
    box.innerHTML = `<p class="hint">地点读取失败（${escapeHtml(code)}）。${reason}</p>
      <button type="button" class="ghost small" id="locRetry">重试</button>`
    $('locRetry')?.addEventListener('click', async () => {
      await loadLocations()
      renderLocationGroups()
    })
    return
  }
  box.innerHTML = groups
    .map(
      (group) => `<section class="loc-group">
        <h4>${escapeHtml(group.label)}${group.id === 'hot' ? ' <span class="hint">常用</span>' : ''}</h4>
        <div class="loc-grid">${(group.items ?? [])
          .map((item) => {
            const on = locationDraft.has(item.value)
            return `<button type="button" class="loc-chip${on ? ' on' : ''}" data-value="${escapeHtml(item.value)}" aria-pressed="${on}">
              <b>${escapeHtml(item.zh)}</b><span>${escapeHtml(item.en)}</span>
            </button>`
          })
          .join('')}</div>
      </section>`,
    )
    .join('')
  for (const chip of box.querySelectorAll('.loc-chip')) {
    chip.addEventListener('click', () => {
      const value = chip.dataset.value
      if (locationDraft.has(value)) locationDraft.delete(value)
      else locationDraft.add(value)
      const on = locationDraft.has(value)
      chip.classList.toggle('on', on)
      chip.setAttribute('aria-pressed', String(on))
      $('locCount').textContent = `已选 ${locationDraft.size} 个`
    })
  }
}

function openLocationModal() {
  locationDraft = new Set(state.locations ?? [])
  renderLocationGroups()
  $('locCount').textContent = `已选 ${locationDraft.size} 个`
  $('locMask').classList.remove('hidden')
  $('locBtn').setAttribute('aria-expanded', 'true')
}

function closeLocationModal() {
  $('locMask').classList.add('hidden')
  $('locBtn').setAttribute('aria-expanded', 'false')
}

function applyLocationModal() {
  state.locations = [...locationDraft]
  syncLocationLabel()
  closeLocationModal()
}

async function loadLocations() {
  const data = await api('/api/locations', { method: 'GET' }).catch(() => null)
  if (data?.ok && Array.isArray(data.groups) && data.groups.length > 0) {
    state.locationGroups = data.groups
    state.locationError = ''
  } else {
    state.locationGroups = []
    state.locationError = data?.code ?? 'E_NETWORK'
  }
  syncLocationLabel()
  // 弹层开得比请求快时，数据回来补渲染一次。
  if (!$('locMask')?.classList.contains('hidden')) renderLocationGroups()
}

async function loadSession() {
  const node = $('sessionMsg')
  if (!node) return
  const data = await api('/api/session', { method: 'GET' }).catch(() => null)
  if (!data) {
    node.textContent = ''
    return
  }
  if (!data.ok) {
    state.loggedIn = false
    // 被 Cloudflare 挡时也把话说清楚，别让登录结果看起来像「什么都没发生」
    node.className = 'hint warn'
    node.textContent = data.reason === 'E_BLOCKED'
      ? 'jobsdb 登录检测被 Cloudflare 挡了；点「过人工验证」，在窗口里登录一次（顺带过验证）'
      : `jobsdb 登录状态未知（${data.reason ?? 'E_BROWSER'}）；点「过人工验证」试一次`
    return
  }
  state.loggedIn = Boolean(data.loggedIn)
  if (data.loggedIn) {
    node.className = 'hint ok'
    node.textContent = 'jobsdb 已登录：可读「Salary match」标记，也能用「精确薪资」二分'
  } else {
    node.className = 'hint'
    node.textContent = 'jobsdb 未登录：点「过人工验证」登录后，才能用「精确薪资」二分'
  }
}

/* ---------- 搜索 / 洞察 / 导出 ---------- */

async function runSearch() {
  const keywords = parseList($('keywords').value)
  if (keywords.length === 0) {
    setMsg('runMsg', '至少给一个关键词', 'error')
    return
  }
  $('runBtn').disabled = true
  setMsg('runMsg', '搜索中…')
  try {
    const body = {
      keywords,
      locations: [...state.locations],
      workTypes: $('workTypes').value ? [$('workTypes').value] : [],
      maxPages: Number($('maxPages').value),
      postedWithinWeeks: state.postedWithinWeeks,
      sources: state.sources,
      weights: currentWeights(),
      rules: { penalty: Number($('penalty').value) / 100 },
    }
    if (state.profile) body.profile = state.profile
    const years = yearsOverride()
    if (body.profile && years !== null) body.profile = { ...body.profile, years }
    const result = await api('/api/search', { body })
    if (!result.ok) {
      setMsg('runMsg', `${result.code}：${result.hint ?? result.message}`, 'error')
      return
    }
    state.run = result
    state.detailLoaded = new Set()
    const perSource = (result.query?.sourceStats ?? [])
      .map((row) => `${JOB_SOURCE_LABEL[row.id] ?? row.id} ${row.count}${row.blocked ? '(被拦)' : row.ok ? '' : '(0)'}`)
      .join(' · ')
    const sourceNote = perSource ? ` ｜ ${perSource}` : ''
    if (!state.profile) {
      renderRows(result.jobs)
      updateCounts({})
      $('counts').textContent = '未打分（先解析简历）'
      setMsg('runMsg', `runId ${result.runId} · 抓到 ${result.query.fetched} 条${sourceNote}，但没有简历画像，所以没有分数与档位；回到上面点「解析」再搜一次`, 'error')
    } else {
      applyRun(result, { message: `runId ${result.runId} · 抓取 ${result.query.fetched} 条 / 共 ${result.query.totalCount}${sourceNote}` })
    }
    loadRuns()
    hydrateDetails()
  } finally {
    $('runBtn').disabled = false
  }
}

function insightRow(term) {
  const pct = Math.max(1, Math.min(100, Math.round(term.pct ?? 0)))
  const tip = `${term.count} 条 / 占 ${term.pct ?? 0}%${term.mentions ? ` · 共提及 ${term.mentions} 次` : ''}${term.companies?.length ? ` · ${term.companies.join('、')}` : ''}`
  return `<div class="insight-row"><span class="insight-label" title="${escapeHtml(tip)}">${escapeHtml(term.label)}</span><span class="insight-bar"><i style="width:${pct}%"></i></span><span class="insight-count" title="${escapeHtml(tip)}">${term.pct ?? 0}%</span></div>`
}

function renderInsight(data) {
  const box = $('insight')
  const groups = data.groups ?? []
  const years = (data.years ?? []).map((item) => `${item.bucket} ${item.count}`).join(' · ')
  const scope = data.scope === 'all' ? `合并 ${data.runCount} 轮 · ` : ''
  const coverage = data.rankedCount ? ` · 简历已覆盖 ${data.covered}/${data.rankedCount} 项` : ''
  const head = `<p class="hint">${scope}柱长＝含该项的 JD 占比${coverage}${years ? ` · 年限：${years}` : ''}</p>`
  const rows = groups
    .map((group) => `<p class="insight-group">${escapeHtml(group.label)}</p>${group.terms.map(insightRow).join('')}`)
    .join('')
  const gaps = data.gaps?.length
    ? `<p class="hint insight-gap">缺口（JD 常提、简历没写）：${data.gaps.map((item) => `${item.label} ${item.pct}%`).join(' · ')}</p>`
    : ''
  const context = data.context?.length
    ? `<p class="hint insight-context">另有（不算能力）：${data.context.map((item) => `${item.label} ${item.pct}%`).join(' · ')}</p>`
    : ''
  const summary = data.summary
  const summaryHtml = summary?.headline
    ? `<details class="insight-summary" open><summary>总结</summary><p class="insight-summary-head">${escapeHtml(summary.headline)}</p>${
        (summary.why ?? []).length
          ? `<p class="insight-sub">为什么是这样</p><ul>${summary.why.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`
          : ''
      }${
        (summary.conclusion ?? []).length
          ? `<p class="insight-sub">结论</p><ul>${summary.conclusion.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`
          : ''
      }</details>`
    : ''
  box.innerHTML = head + (rows || '<p class="empty">这几条 JD 里没识别出能力项</p>') + gaps + context + summaryHtml
}

async function runInsight() {
  if (!state.run) {
    setMsg('insightMsg', '先跑一次搜索，再点分析', 'error')
    return
  }
  const allRuns = Boolean($('insightAll')?.checked)
  $('insightBtn').disabled = true
  setMsg('insightMsg', `补全本轮全部 JD${allRuns ? '，并合并历史 run' : ''}…（首次会慢一些）`)
  try {
    // 只统计 JD 正文，不需要公司档案：withProfile=false 能省掉每条一次的档案请求。
    const loaded = await api('/api/jobs', { body: { runId: state.run.runId, all: true, withProfile: false } })
    if (!loaded.ok) {
      setMsg('insightMsg', `${loaded.code}：${loaded.hint ?? loaded.message}`, 'error')
      return
    }
    if (Array.isArray(loaded.ranked)) {
      state.run = { ...state.run, jobs: loaded.ranked, counts: loaded.counts ?? state.run.counts }
      renderRows(loaded.ranked)
      updateCounts(loaded.counts ?? state.run.counts)
      for (const job of loaded.ranked) state.detailLoaded.add(String(job.id))
    }
    const result = await api(`/api/insight?runId=${encodeURIComponent(state.run.runId)}&scope=${allRuns ? 'all' : 'run'}`, { method: 'GET' })
    if (!result.ok) {
      setMsg('insightMsg', `${result.code}：${result.hint ?? result.message}`, 'error')
      return
    }
    renderInsight(result)
    const scopeNote = result.scope === 'all' ? `合并 ${result.runCount} 轮 · ` : ''
    setMsg('insightMsg', `${scopeNote}已分析 ${result.jdCount} 条 JD，抓取失败 ${result.missing ?? 0} 条`, 'ok')
  } finally {
    $('insightBtn').disabled = false
  }
}

// 「打开报告」：第一次点才生成 report.md，生成了直接打开；不再单独放导出按钮。
async function openReport() {
  if (!state.run) {
    setMsg('runMsg', '先跑一次搜索', 'error')
    return
  }
  const link = $('reportLink')
  const result = await api('/api/report', { body: { runId: state.run.runId } })
  if (!result.ok) {
    setMsg('runMsg', `${result.code}：${result.hint ?? result.message}`, 'error')
    return
  }
  link.href = `/api/runs/${result.runId}/report?token=${encodeURIComponent(token)}`
  link.classList.remove('disabled')
  window.open(link.href, '_blank')
  setMsg('runMsg', `报告已生成：${result.markdown.path}`, 'ok')
}

/* ---------- 来源操作 ---------- */

async function probeSources() {
  $('probeBtn').disabled = true
  setMsg('srcMsg', '逐个来源试一遍，几秒…')
  try {
    const data = await api('/api/probe', { method: 'GET' })
    if (!data.ok) {
      setMsg('srcMsg', `${data.code}：${data.message}`, 'error')
      return
    }
    const rows = (data.rows ?? []).map((row) => {
      const stateText = row.ok ? `通 (${row.count} 条)` : row.blocked ? '被拦' : '不通'
      return `${row.label}：${stateText}${row.note ? ` — ${row.note}` : ''}`
    })
    setMsg('srcMsg', rows.join('；'), 'hint')
  } finally {
    $('probeBtn').disabled = false
  }
}

async function login() {
  const pick = prompt('要对哪个站点做人工验证？（jobsdb）', 'jobsdb')
  if (!pick) return
  $('loginBtn').disabled = true
  setMsg('srcMsg', '正在打开浏览器窗口，过完验证后自己关掉窗口，这里会自动继续…')
  try {
    const data = await api('/api/browser-login', { body: { site: pick.trim().toLowerCase(), seconds: 180 } })
    if (!data.ok) {
      setMsg('srcMsg', `${data.code}：${data.message}`, 'error')
      return
    }
    setMsg('srcMsg', `已结束（${data.reason}）。验证过的 cookie 存在 ${data.profile}`, 'ok')
    loadSession() // 登录后立刻刷新上面的登录状态，不用手动刷新页面
  } finally {
    $('loginBtn').disabled = false
  }
}

/* ---------- 布局 / 语言 ---------- */

function initSplitter() {
  const splitter = $('splitter')
  const split = splitter.parentElement
  const saved = Number(localStorage.getItem('jobmatch-list-width'))
  if (Number.isFinite(saved) && saved >= 300 && saved <= 760) split.style.setProperty('--list-w', `${saved}px`)
  let dragging = false
  splitter.addEventListener('mousedown', (event) => {
    dragging = true
    splitter.classList.add('dragging')
    event.preventDefault()
  })
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return
    const left = split.getBoundingClientRect().left
    const width = Math.min(760, Math.max(300, event.clientX - left))
    split.style.setProperty('--list-w', `${width}px`)
  })
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    splitter.classList.remove('dragging')
    const value = split.style.getPropertyValue('--list-w')
    if (value) localStorage.setItem('jobmatch-list-width', String(parseInt(value, 10)))
  })
  splitter.addEventListener('dblclick', () => {
    split.style.setProperty('--list-w', '440px')
    localStorage.removeItem('jobmatch-list-width')
  })
}

function initLanguage() {
  $('langBtn').addEventListener('click', () => {
    state.lang = state.lang === 'zh' ? 'en' : 'zh'
    $('langBtn').textContent = state.lang === 'zh' ? '原文' : '中文'
    if (state.run) renderRows(state.run.jobs)
    if (state.activeJob) openDetail(state.activeJob)
  })
}

/** 发布时间窗口：只影响标红，不删除岗位。 */
function initPostedWindow() {
  const input = $('postedWithin')
  if (!input) return
  try {
    const saved = Number(localStorage.getItem('jobmatch.postedWeeks'))
    if (Number.isFinite(saved) && saved >= 1) state.postedWithinWeeks = Math.min(52, Math.round(saved))
  } catch {}
  input.value = String(state.postedWithinWeeks)

  const sync = () => {
    const value = Math.min(52, Math.max(1, Math.round(Number(input.value) || 4)))
    state.postedWithinWeeks = value
    input.value = String(value)
    try {
      localStorage.setItem('jobmatch.postedWeeks', String(value))
    } catch {}
    const hint = $('postedHint')
    if (hint) hint.textContent = `超过 ${value} 周的岗位保留，公司名标红`
    if (state.run) renderRows(state.run.jobs)
  }
  input.addEventListener('change', sync)
  input.addEventListener('blur', sync)
  sync()
}

/* ---------- 启动 ---------- */

async function bootPage() {
  initWeights()
  initResume()
  initSalaryReport()
  initLanguage()
  initPostedWindow()
  initSplitter()

  bus.addEventListener('open-job', (event) => openDetail(event.detail))
  bus.addEventListener('run-applied', (event) => setWeightsFromRun(event.detail))

  $('runBtn').addEventListener('click', runSearch)
  $('insightBtn').addEventListener('click', runInsight)
  $('reportLink').addEventListener('click', (event) => {
    // 第一次点击时先生成报告；已有 href 就直接走默认行为。
    if ($('reportLink').getAttribute('href')) return
    event.preventDefault()
    openReport()
  })
  $('probeBtn')?.addEventListener('click', probeSources)
  $('loginBtn')?.addEventListener('click', login)

  $('locBtn')?.addEventListener('click', openLocationModal)
  $('locClose')?.addEventListener('click', closeLocationModal)
  $('locApply')?.addEventListener('click', applyLocationModal)
  $('locClear')?.addEventListener('click', () => {
    locationDraft.clear()
    for (const chip of $('locGroups').querySelectorAll('.loc-chip')) {
      chip.classList.remove('on')
      chip.setAttribute('aria-pressed', 'false')
    }
    $('locCount').textContent = '已选 0 个'
  })
  $('locMask')?.addEventListener('click', (event) => {
    if (event.target === $('locMask')) closeLocationModal()
  })
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('locMask')?.classList.contains('hidden')) closeLocationModal()
  })

  const translated = await api('/api/translations', { method: 'GET' }).catch(() => null)
  if (translated?.ok) state.translations = translated.map ?? {}
  const health = await api('/api/health', { method: 'GET' }).catch(() => null)
  if (health?.ok) {
    $('healthText').textContent = `服务就绪 · v${health.version}`
    $('health').classList.add('ok')
  } else {
    $('healthText').textContent = '服务未就绪'
    $('health').classList.add('bad')
  }
  loadRuns()
  loadSources()
  loadLocations()
  loadSession()
  await restoreProfile()
  try {
    const storedYears = localStorage.getItem('jobmatch.years')
    if (storedYears !== null && $('yearsOverride')) $('yearsOverride').value = storedYears
  } catch {}
  $('yearsOverride')?.addEventListener('change', () => {
    rememberYears()
    const years = yearsOverride()
    setMsg('runMsg', years === null ? '经验年限已改回「按简历自动」' : `经验年限按 ${years} 年计算；点「开始匹配」或「应用并重排」生效`)
  })
  const latest = await api('/api/latest', { method: 'GET' }).catch(() => null)
  if (latest && Array.isArray(latest.jobs) && latest.jobs.length > 0) {
    applyRun(latest, { message: `上次运行 ${latest.runId}（${latest.jobs.length} 条）` })
    const pages = Number(latest.query?.maxPages)
    if (Number.isFinite(pages) && pages >= 1 && pages <= 3) $('maxPages').value = String(pages)
    if (Array.isArray(latest.query?.locations)) {
      state.locations = latest.query.locations.filter((item) => typeof item === 'string')
      syncLocationLabel()
    }
    const restoredType = latest.query?.workTypes?.[0]
    if (restoredType && $('workTypes')) $('workTypes').value = restoredType
    // 旧页面恢复时也重排一次：让已补全的 JD 年限进入分数；
    // run 缺失时静默跳过，不打扰用户。
    if (latest.jobs.some((job) => (job.contentChars ?? 0) > 0)) {
      await applyWeights({ silent: true, quiet: true })
    }
    const insightParam = new URLSearchParams(location.search).get('insight')
    if (insightParam !== null) {
      // ?insight=all 顺便勾上「合并历史 run」，方便直接打开一个固定视图。
      if (insightParam === 'all' && $('insightAll')) $('insightAll').checked = true
      $('insightBtn').click()
    }
    // ?salary=1 直接跑一次薪酬参考，方便截图/复现。
    if (new URLSearchParams(location.search).has('salary')) $('salRefBtn')?.click()
  }
}

// 浏览器内自检：URL 带 ?selftest=1 时，页面自己走完 解析 → 搜索 → 详情 → 比例重排 → 导出。
async function runSelfTest() {
  const log = []
  try {
    const sample = $('resumeText').value || '陈大文，数据分析师，5 年经验。技能：SQL、Python、Power BI、Tableau、Excel。做过零售与电商经营看板，负责 ETL 与数据仓库建模，英语与粤语可沟通，期望香港的 data analyst 岗位。'
    const resume = await api('/api/resume', { body: { text: sample } })
    log.push(`resume=${resume.ok},years=${resume.profile?.years ?? 'null'}`)
    if (!resume.ok) throw new Error(resume.code)
    state.profile = resume.profile
    chips(resume.profile)
    const search = await api('/api/search', { body: { keywords: ['data analyst'], maxPages: 1, profile: resume.profile, weights: currentWeights(), rules: { penalty: Number($('penalty').value) / 100 } } })
    log.push(`search=${search.ok},jobs=${search.jobs?.length ?? 0}`)
    if (!search.ok) throw new Error(search.code)
    state.run = search
    state.detailLoaded = new Set()
    applyRun(search)
    const selftestCounts = search.counts ?? {}
    log.push(`counts=A${selftestCounts.A ?? 0}/B${selftestCounts.B ?? 0}/C${selftestCounts.C ?? 0}/X${selftestCounts.X ?? 0}`)
    const first = search.jobs[0]
    await openDetail(first)
    const refreshed = (state.run.jobs ?? []).find((job) => jobKey(job) === jobKey(first)) ?? first
    log.push(`detailChars=${(refreshed.contentText ?? '').length},src=${refreshed.jdSource ?? '?'},exp=${refreshed.experience?.requiredYears ?? 'null'}`)
    const rescored = await api('/api/rescore', { body: { runId: search.runId, weights: currentWeights(), rules: { penalty: 0.3 } } })
    log.push(`rescore=${rescored.ok},penalty=${rescored.rules?.penalty}`)
    if (!rescored.ok) throw new Error(rescored.code)
    const report = await api('/api/report', { body: { runId: search.runId } })
    log.push(`report=${report.ok}`)
    if (!report.ok) throw new Error(report.code)
    const pre = document.createElement('pre')
    pre.id = 'selftest'
    pre.textContent = `SELFTEST OK ${log.join(' ')}`
    document.body.appendChild(pre)
    document.title = pre.textContent
  } catch (error) {
    const pre = document.createElement('pre')
    pre.id = 'selftest'
    pre.textContent = `SELFTEST ERR ${log.join(' ')} ${String(error?.message ?? error)}`
    document.body.appendChild(pre)
    document.title = pre.textContent
  }
}

bootPage()
if (new URLSearchParams(location.search).has('selftest')) runSelfTest()
