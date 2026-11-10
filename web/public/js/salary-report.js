import { $, api, escapeHtml, setMsg } from './core.js'

function salaryK(value) {
  if (value == null) return '—'
  return `${Math.round(value / 100) / 10}K`
}

/**
 * 按 JD 年限分档的明码薪资表。
 * 明码样本缺失时，额外给一列「推测中位」（平台档位加权，只能看量级、拆不到年限）。
 */
export function renderSalaryBands(data) {
  const box = $('salRefTable')
  if (!box) return
  if (!data?.ok) {
    box.innerHTML = `<p class="hint">${escapeHtml(data?.code ?? '出错了')}${data?.message ? `：${escapeHtml(data.message)}` : ''}</p>`
    return
  }

  const inferred = data.inferred
  const inferCell = () =>
    inferred
      ? `<span class="infer" title="平台 11 个 5K 薪资档按档中心加权，只能看量级、拆不到年限">≈${salaryK(inferred.median)}*</span>`
      : '—'

  const rowHtml = (row, extra = '') => {
    const thin = row.n > 0 && row.n < 5
    const range = row.min == null ? '—' : `${salaryK(row.min)}–${salaryK(row.max)}`
    // 明码有样本就显示明码；没有样本才用推测值顶上（标 * 表示推算）。
    const medianCell = row.median == null ? (inferred ? inferCell() : '—') : salaryK(row.median)
    const iqrCell = row.p25 && row.p75 ? `${salaryK(row.p25)}–${salaryK(row.p75)}` : inferred ? `≈${salaryK(inferred.p25)}–${salaryK(inferred.p75)}*` : '—'
    return `<tr class="${thin ? 'thin' : ''}">
      <td>${escapeHtml(row.label)}${extra}</td>
      <td class="num">${row.n || '—'}</td>
      <td class="num">${medianCell}</td>
      <td class="num">${iqrCell}</td>
      <td class="num">${range}</td>
    </tr>`
  }

  const rows = (data.rows ?? []).map((row) => rowHtml(row))
  rows.push(rowHtml({ id: 'all', label: '整体（明码）', ...(data.overall ?? {}) }))

  const coverage = `扫了 ${data.scanned} 条岗位（标题同时含关键词的 ${data.titleHits ?? '—'} 条）· 明码月薪 ${data.explicit} 条 · 抓到 JD ${data.fetchedJd} 条 · 能解析出年限 ${data.yearsKnown} 条 · 最终用到 ${data.used} 条`
  const weakMatch = Number.isFinite(data.titleHits) && data.scanned > 0 && data.titleHits / data.scanned < 0.2
  const warn = weakMatch
    ? `<p class="hint">标题同时含这些词的只有 ${data.titleHits}/${data.scanned} 条，其余多是正文提到 —— 这个关键词的明码样本可能混进不相关岗位，建议只当参考。</p>`
    : ''
  const inferNote = inferred
    ? `* 推测中位 ≈${salaryK(inferred.median)}（P25–P75 ≈${salaryK(inferred.p25)}–${salaryK(inferred.p75)}）：拿平台「${escapeHtml(data.keyword)}」${inferred.jobs ?? 0} 条岗位的 11 个薪资档加权（档合计 ${inferred.bandTotal ?? 0}）。只能看量级，拆不到年限，也别当某条岗位的薪资。`
    : '* 推测值没算出来（平台档位接口没返回）。'

  box.innerHTML = `<table class="saltable">
    <thead><tr><th>年限</th><th>样本</th><th>中位</th><th>P25–P75</th><th>区间</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>
    <p class="hint">${escapeHtml(coverage)}（${(data.ms / 1000).toFixed(1)}s，${data.pages} 页）</p>
    ${warn}
    <p class="hint">明码 = JD 里写明月薪的岗位算出来的；灰色行＝样本 &lt;5，只能看方向。${data.note ? escapeHtml(data.note) : ''}</p>
    <p class="hint">${inferNote}</p>`
}

export function initSalaryReport() {
  $('salRefBtn')?.addEventListener('click', async () => {
    const keyword = ($('keywords').value || '').trim()
    if (!keyword) {
      setMsg('salRefMsg', '先在上面填关键词', 'error')
      return
    }
    $('salRefBtn').disabled = true
    setMsg('salRefMsg', '抓这个关键词的岗位，再逐条读 JD 的薪资和年限，约 20–60 秒（平台限速时更久）…')
    try {
      const data = await api('/api/salary-bands', { body: { keyword, pages: 10, maxJd: 40 } })
      if (!data.ok) {
        setMsg('salRefMsg', `${data.code}：${data.message ?? ''}`, 'error')
        return
      }
      renderSalaryBands(data)
      const hasReal = (data.used ?? 0) > 0
      setMsg(
        'salRefMsg',
        hasReal
          ? `明码 ${data.used} 条入表；扫 ${data.scanned} 条，明码 ${data.explicit} 条，用时 ${(data.ms / 1000).toFixed(1)}s`
          : `这个关键词没有明码薪资样本，底下给的是平台推测值（≈）`,
        hasReal ? 'ok' : 'error',
      )
    } finally {
      $('salRefBtn').disabled = false
    }
  })
}
