import { $, api, escapeHtml, setMsg, state, token } from './core.js'
import { updateYearsHint } from './weights.js'

export function chips(profile) {
  const box = $('chips')
  box.innerHTML = ''
  const items = [...(profile.skills ?? []).slice(0, 4)]
  if (items.length === 0) {
    box.innerHTML = '<span class="hint">没有识别出技能，换个写法试试</span>'
  } else {
    for (const label of items) {
      const span = document.createElement('span')
      span.className = 'chip'
      span.textContent = label
      box.appendChild(span)
    }
    if (profile.years) {
      const span = document.createElement('span')
      span.className = 'chip neutral'
      span.textContent = `${profile.years} 年`
      box.appendChild(span)
    }
  }
  renderUnderstanding(profile)
  updateYearsHint(profile)
}

/** 「简历理解」面板：先给推荐方向（点一下就搜），再一句话概述 + 经历要点。 */
export function renderUnderstanding(profile) {
  const box = $('resumeRead')
  if (!box) return
  const u = profile?.understanding
  if (!u) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  const directions = (u.directions ?? [])
    .map((direction) => {
      const buttons = (direction.keywords ?? [])
        .slice(0, 2)
        .map((keyword) => `<button type="button" class="kw solid" data-kw="${escapeHtml(keyword)}">${escapeHtml(keyword)}</button>`)
        .join('')
      return `<div class="read-dir">
        <div class="read-dir-head"><b>${escapeHtml(direction.label)}</b><span class="hint">${escapeHtml(direction.reason ?? '')}</span></div>
        <div class="read-dir-actions">${buttons}</div>
      </div>`
    })
    .join('')
  const roles = (u.roles ?? [])
    .slice(0, 3)
    .map((role) => {
      const head = [role.title ? `<b>${escapeHtml(role.title)}</b>` : '', role.company ? `<span>${escapeHtml(role.company)}</span>` : '', role.period ? `<em>${escapeHtml(role.period)}</em>` : '']
        .filter(Boolean)
        .join(' ')
      const list = (role.highlights ?? []).length > 0
        ? `<ul>${role.highlights.slice(0, 2).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : ''
      return head || list ? `<div class="read-role"><div class="read-role-head">${head || '（这一段没读出职位）'}</div>${list}</div>` : ''
    })
    .filter(Boolean)
    .join('')
  const keywords = (u.keywords ?? []).slice(0, 10)
  const kws = keywords
    .map((item) => {
      const title = [item.kind, item.evidence].filter(Boolean).join(' · ')
      return `<button type="button" class="kw" data-kw="${escapeHtml(item.label)}" title="${escapeHtml(title)}">${escapeHtml(item.label)}<span class="kw-kind">${escapeHtml(item.kind)}</span></button>`
    })
    .join('')
  box.innerHTML = `
    <div class="read-head">简历理解 <span class="hint">${escapeHtml(u.seniority ?? '')}</span></div>
    ${directions ? `<div class="read-dirs">${directions}</div>` : ''}
    ${u.summary ? `<p class="read-summary">${escapeHtml(u.summary)}</p>` : ''}
    ${roles ? `<div class="read-roles">${roles}</div>` : ''}
    ${kws ? `<details class="read-more"><summary>全部关键词（${keywords.length}）</summary><div class="read-kws">${kws}</div></details>` : ''}
  `
  box.hidden = false
  for (const button of box.querySelectorAll('.kw')) {
    button.addEventListener('click', () => {
      const input = $('keywords')
      if (!input) return
      const value = button.dataset.kw ?? ''
      input.value = value
      setMsg('runMsg', `搜索关键词已切到「${value}」，可以直接点「开始匹配」`, 'ok')
      input.focus()
    })
  }
  const input = $('keywords')
  const preferred = (u.directions ?? [])[0]?.keywords?.[0] ?? (u.searchKeywords ?? [])[0]
  if (input && (input.value.trim() === '' || input.value.trim() === 'data analyst') && preferred) {
    input.value = preferred
  }
}

/** 刷新页面后恢复上次解析的简历画像（服务端存在 data/profile.json）。 */
export async function restoreProfile() {
  const saved = await api('/api/profile', { method: 'GET' }).catch(() => null)
  if (!saved?.ok || !saved.profile) return
  state.profile = saved.profile
  chips(saved.profile)
  const text = String(saved.text ?? '')
  if (text && !$('resumeText').value.trim()) $('resumeText').value = text
  const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString('zh-CN', { hour12: false }) : ''
  setMsg('resumeMsg', `已恢复上次解析的简历（${saved.textChars ?? text.length} 字${when ? ` · ${when}` : ''}），不用重新上传`)
}

export async function parseResume() {
  const text = $('resumeText').value.trim()
  const path = $('resumePath').value.trim()
  if (!text && !path) {
    setMsg('resumeMsg', '给简历文本或路径', 'error')
    return
  }
  $('parseBtn').disabled = true
  setMsg('resumeMsg', '解析中…')
  try {
    const result = await api('/api/resume', { body: text ? { text } : { path } })
    if (!result.ok) {
      setMsg('resumeMsg', `${result.code}：${result.hint ?? result.message}`, 'error')
      return
    }
    state.profile = result.profile
    chips(result.profile)
    setMsg(
      'resumeMsg',
      `已解析 ${result.textChars} 字，${(result.profile.skills ?? []).length} 个技能${result.profile.years ? ` · ${result.profile.years} 年经验` : ''}`,
      'ok',
    )
    if (!($('keywords').value ?? '').trim() && (result.profile.titles ?? []).length > 0) {
      $('keywords').value = result.profile.titles[0]
    }
  } finally {
    $('parseBtn').disabled = false
  }
}

export async function uploadFile(file) {
  if (!file) return
  const name = file.name || 'resume'
  setMsg('resumeMsg', `上传 ${name}（${Math.max(1, Math.round(file.size / 1024))} KB）…`)
  $('parseBtn').disabled = true
  try {
    const response = await fetch(`/api/resume/upload?name=${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'x-jobmatch-token': token, 'content-type': 'application/octet-stream' },
      body: await file.arrayBuffer(),
    })
    const result = await response.json().catch(() => ({ ok: false, code: 'E_INTERNAL', message: '响应不是 JSON' }))
    if (!result.ok) {
      setMsg('resumeMsg', `${result.code}：${result.hint ?? result.message}`, 'error')
      return
    }
    state.profile = result.profile
    chips(result.profile)
    setMsg(
      'resumeMsg',
      `${name}：${result.textChars} 字，${(result.profile.skills ?? []).length} 个技能${result.profile.years ? ` · ${result.profile.years} 年经验` : ''}`,
      'ok',
    )
    if (!($('keywords').value ?? '').trim() && (result.profile.titles ?? []).length > 0) {
      $('keywords').value = result.profile.titles[0]
    }
  } finally {
    $('parseBtn').disabled = false
  }
}

export function initResume() {
  $('parseBtn').addEventListener('click', parseResume)
  const dropZone = $('drop')
  dropZone.addEventListener('click', () => $('fileInput').click())
  $('fileInput').addEventListener('change', (event) => uploadFile(event.target.files?.[0]))
  for (const type of ['dragenter', 'dragover']) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault()
      dropZone.classList.add('over')
    })
  }
  for (const type of ['dragleave', 'drop']) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault()
      dropZone.classList.remove('over')
    })
  }
  dropZone.addEventListener('drop', (event) => uploadFile(event.dataTransfer?.files?.[0]))
  window.addEventListener('dragover', (event) => event.preventDefault())
  window.addEventListener('drop', (event) => event.preventDefault())
}
