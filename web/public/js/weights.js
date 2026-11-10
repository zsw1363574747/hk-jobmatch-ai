import { $, DEFAULT_WEIGHTS, WEIGHT_META, api, escapeHtml, setMsg, state } from './core.js'
import { renderRows, updateCounts } from './results.js'

export function buildWeightRows() {
  const box = $('weightRows')
  box.innerHTML = ''
  for (const meta of WEIGHT_META) {
    const row = document.createElement('label')
    row.className = 'wrow'
    row.innerHTML = `<span class="wlabel" title="${escapeHtml(meta.hint)}">${escapeHtml(meta.label)}</span>
      <input type="number" min="0" max="100" step="1" inputmode="numeric" data-weight="${meta.key}" aria-label="${escapeHtml(meta.label)}权重（百分比）">
      <span class="unit">%</span>`
    box.appendChild(row)
  }
  box.addEventListener('input', onWeightInput)
  box.addEventListener('change', onWeightInput)
}

export function weightInput(key) {
  return document.querySelector(`[data-weight="${key}"]`)
}

export function syncWeightLabels() {
  let total = 0
  for (const meta of WEIGHT_META) {
    const input = weightInput(meta.key)
    if (!input) continue
    total += Math.max(0, Number(input.value) || 0)
  }
  const hint = $('weightsHint')
  hint.textContent = total === 100 ? '合计 100%' : `合计 ${total}% · 按比例归一`
  hint.classList.toggle('warn', total !== 100)
}

export function currentWeights() {
  const weights = {}
  let total = 0
  for (const meta of WEIGHT_META) {
    const value = Math.max(0, Number(weightInput(meta.key)?.value) || 0)
    weights[meta.key] = value
    total += value
  }
  if (total <= 0) return null
  for (const key of Object.keys(weights)) weights[key] = weights[key] / total
  return weights
}

export function setWeightsFromRun(run) {
  const weights = run?.weights ?? null
  for (const meta of WEIGHT_META) {
    const input = weightInput(meta.key)
    if (!input) continue
    const value = weights && Number.isFinite(weights[meta.key]) ? Math.round(weights[meta.key] * 100) : DEFAULT_WEIGHTS[meta.key]
    input.value = String(value)
  }
  const penalty = Number(run?.rules?.penalty)
  if (Number.isFinite(penalty)) {
    $('penalty').value = String(Math.round(penalty * 100))
    $('penaltyOut').textContent = `×${penalty.toFixed(2)}`
  } else {
    $('penaltyOut').textContent = `×${(Number($('penalty').value) / 100).toFixed(2)}`
  }
  syncWeightLabels()
}

/** 用户手填的经验年限：空 = 按简历；填了就以它为准。 */
export function yearsOverride() {
  const input = $('yearsOverride')
  if (!input) return null
  const raw = String(input.value ?? '').trim()
  if (raw === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 40) return null
  return Math.round(value)
}

export function rememberYears() {
  const value = yearsOverride()
  try {
    if (value === null) localStorage.removeItem('jobmatch.years')
    else localStorage.setItem('jobmatch.years', String(value))
  } catch {}
}

export function updateYearsHint(profile) {
  const input = $('yearsOverride')
  if (!input) return
  const parsed = profile?.years
  input.placeholder = Number.isFinite(parsed) ? `按简历：${parsed} 年` : '按简历自动'
  if (String(input.value).trim() === '' && !Number.isFinite(parsed)) input.placeholder = '按简历自动（未写可手填）'
}

export function onWeightInput() {
  syncWeightLabels()
  clearTimeout(state.rescoreTimer)
  state.rescoreTimer = setTimeout(() => applyWeights({ silent: true }), 350)
}

export async function applyWeights({ silent = false, quiet = false } = {}) {
  if (!state.run?.runId) {
    if (!silent && !quiet) setMsg('runMsg', '先跑一次搜索，比例才会生效', 'error')
    return
  }
  const weights = currentWeights()
  if (!weights) {
    if (!quiet) setMsg('runMsg', '比例合计不能为 0', 'error')
    return
  }
  const result = await api('/api/rescore', {
    body: { runId: state.run.runId, years: yearsOverride(), weights, rules: { penalty: Number($('penalty').value) / 100 } },
  })
  if (!result.ok) {
    if (!quiet) setMsg('runMsg', `${result.code}：${result.hint ?? result.message}`, 'error')
    return
  }
  state.run = { ...state.run, jobs: result.jobs, counts: result.counts, weights: result.weights, rules: result.rules }
  renderRows(result.jobs)
  updateCounts(result.counts)
  if (!quiet) setMsg('runMsg', silent ? '已按新比例重排' : '已重排', 'ok')
}

export function weightsOpen() {
  $('weightsMask').classList.remove('hidden')
  $('weightsBtn').setAttribute('aria-expanded', 'true')
  const first = $('weightRows').querySelector('input')
  if (first) first.focus()
}

export function weightsClose() {
  $('weightsMask').classList.add('hidden')
  $('weightsBtn').setAttribute('aria-expanded', 'false')
}

export function initWeights() {
  buildWeightRows()
  setWeightsFromRun(null)
  $('penalty').addEventListener('input', () => {
    $('penaltyOut').textContent = `×${(Number($('penalty').value) / 100).toFixed(2)}`
    clearTimeout(state.rescoreTimer)
    state.rescoreTimer = setTimeout(() => applyWeights({ silent: true }), 350)
  })
  $('weightsBtn').addEventListener('click', weightsOpen)
  $('weightsClose').addEventListener('click', weightsClose)
  $('weightsApply').addEventListener('click', async () => {
    await applyWeights()
    weightsClose()
  })
  $('weightsMask').addEventListener('click', (event) => {
    if (event.target === $('weightsMask')) weightsClose()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('weightsMask').classList.contains('hidden')) weightsClose()
  })
  $('weightsReset').addEventListener('click', async () => {
    setWeightsFromRun(null)
    $('penalty').value = '50'
    $('penaltyOut').textContent = '×0.50'
    await applyWeights({ silent: true })
  })
}
