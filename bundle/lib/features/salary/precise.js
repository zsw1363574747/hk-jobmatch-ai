/**
 * 用「Salary match」徽章二分岗位的隐藏薪资。
 *
 * 原理（2026-11 实测）：徽章 `data-automation="job-detail-salary-match"`
 * 只在「你资料里的期望薪资 ∈ 岗位薪资区间」时出现，且是闭区间：
 * 例如岗位 264,000–312,000/年，期望 263,000 无徽章、264,000 有、312,000 有、313,000 无。
 *
 * 所以改一次期望薪资 + 渲染一次详情页，就得到一次 yes/no；对上下边界各二分一次，
 * 就能把区间精确到 1,000 HKD/年（约 83 HKD/月）。
 *
 * 代价：每次 yes/no 要动一次账号资料（约 8–10 秒），一个岗位约 15–25 次。
 * 因此只在用户显式点「精确薪资」时跑，跑完 finally 恢复原期望薪资。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderPage, renderSteps } from '../../sources/browser.js'
import { probeSalary } from './probe.js'

const PROFILE_URL = 'https://hk.jobsdb.com/profile/me'
const STEP = 1000
const MIN_ANNUAL = 60000
const MAX_ANNUAL = 1200000
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function roundTo(v, step = STEP) {
  return Math.round(v / step) * step
}

function money(v) {
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function parseJson(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
}

/** 打开「薪酬期望」编辑框，读出当前值，然后取消（不改动）。 */
const READ_SCRIPT = `(async () => {
  const btn = document.querySelector('[data-automation="salary-edit-button"]');
  if (!btn) return JSON.stringify({ ok: false, reason: 'NO_EDIT_BUTTON' });
  btn.click();
  await new Promise((r) => setTimeout(r, 900));
  const input = document.querySelector('#salary-field-HK');
  const select = document.querySelector('#salary-type-dropdown-HK');
  const value = input ? input.value : '';
  const type = select ? select.value : '';
  const cancel = document.querySelector('[data-automation="salary-cancel-button"]');
  if (cancel) cancel.click();
  await new Promise((r) => setTimeout(r, 300));
  return JSON.stringify({ ok: Boolean(value), value, type });
})()`

function editScript(amount, type = 'Annual') {
  return `(async () => {
    const btn = document.querySelector('[data-automation="salary-edit-button"]');
    if (!btn) return JSON.stringify({ ok: false, reason: 'NO_EDIT_BUTTON' });
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    const input = document.querySelector('#salary-field-HK');
    if (!input) return JSON.stringify({ ok: false, reason: 'NO_INPUT' });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(money(amount))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const select = document.querySelector('#salary-type-dropdown-HK');
    if (select) {
      select.value = ${JSON.stringify(type)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 350));
    const save = document.querySelector('[data-automation="salary-save-button"]');
    if (!save) return JSON.stringify({ ok: false, reason: 'NO_SAVE_BUTTON' });
    save.click();
    await new Promise((r) => setTimeout(r, 2000));
    return JSON.stringify({ ok: !document.querySelector('#salary-field-HK') });
  })()`
}

const BADGE_SCRIPT = `(() => {
  const el = document.querySelector('[data-automation="job-detail-salary-match"]');
  return JSON.stringify({
    badge: Boolean(el),
    label: el ? el.innerText : null,
    blocked: /Just a moment/i.test(document.title),
  });
})()`

function cachePath(dataDir) {
  return join(dataDir ?? '.', 'salary-precise-cache.json')
}

async function readCache(dataDir) {
  try {
    return JSON.parse(await readFile(cachePath(dataDir), 'utf8'))
  } catch {
    return {}
  }
}

async function writeCache(dataDir, cache) {
  try {
    await mkdir(dataDir ?? '.', { recursive: true })
    await writeFile(cachePath(dataDir), JSON.stringify(cache), 'utf8')
  } catch {}
}

/** 粗区间：薪资筛选命中的 5k 档位 → 年度上下限，两侧再留 12k 余量。 */
export function boundsFrom(job, bandsInput) {
  const bands = Array.isArray(bandsInput)
    ? bandsInput
    : Array.isArray(job?.salary?.evidence?.bands)
      ? job.salary.evidence.bands
      : []
  const lows = []
  const highs = []
  for (const band of bands) {
    const [low, high] = String(band).split('-').map(Number)
    if (Number.isFinite(low)) lows.push(low)
    if (Number.isFinite(high)) highs.push(high)
  }
  let lowMonth
  let highMonth
  if (lows.length > 0) {
    lowMonth = Math.min(...lows)
    highMonth = Math.max(...highs)
  } else if (Number.isFinite(job?.salary?.min)) {
    lowMonth = job.salary.min
    highMonth = Number.isFinite(job?.salary?.max) ? job.salary.max : job.salary.min
  } else {
    lowMonth = 10000
    highMonth = 60000
  }
  const low = Math.max(MIN_ANNUAL, roundTo((lowMonth - 1) * 12 - 12000))
  const high = Math.min(MAX_ANNUAL, roundTo((highMonth + 1) * 12 + 12000))
  return { low, high }
}

/**
 * 纯二分：已知 [low, high] 两端为「无徽章」，中间有一段连续「有徽章」。
 * badgeAt(v) 返回 Promise<boolean>；测试里可以注入假函数。
 */
export async function bisectRange({ low, high, badgeAt, step = STEP, maxChecks = 80 }) {
  let checks = 0
  const ask = async (value) => {
    if (checks >= maxChecks) throw Object.assign(new Error('二分次数超过上限'), { code: 'E_TOO_MANY_CHECKS' })
    checks += 1
    return Boolean(await badgeAt(value))
  }

  let lo = roundTo(low, step)
  let hi = roundTo(high, step)
  if (hi - lo < step) return { ok: false, reason: 'E_BAD_RANGE', checks }

  // 粗区间理应落在岗位区间外；万一落进去了，就向外扩。
  let guard = 0
  while (await ask(lo)) {
    lo -= Math.max(step, roundTo((hi - lo) / 2, step))
    if (lo < 0 || ++guard > 6) return { ok: false, reason: 'E_RANGE_TOO_WIDE', checks }
  }
  guard = 0
  while (await ask(hi)) {
    hi += Math.max(step, roundTo((hi - lo) / 2, step))
    if (++guard > 6) return { ok: false, reason: 'E_RANGE_TOO_WIDE', checks }
  }

  // 在区间内采样找第一个「有徽章」的点。粗区间来自 5k 档位，7 个采样点足够覆盖。
  const samples = []
  for (let i = 1; i <= 7; i += 1) samples.push(roundTo(lo + ((hi - lo) * i) / 8, step))
  let firstTrue = null
  for (const sample of samples) {
    if (await ask(sample)) {
      firstTrue = sample
      break
    }
  }
  if (firstTrue === null) return { ok: false, reason: 'E_NO_BADGE', checks }

  // 下边界：lo(false) → firstTrue(true)
  let a = lo
  let b = firstTrue
  while (b - a > step) {
    const mid = roundTo((a + b) / 2, step)
    if (mid <= a || mid >= b) break
    if (await ask(mid)) b = mid
    else a = mid
  }
  const min = b

  // 上边界：firstTrue(true) → hi(false)
  let c = firstTrue
  let d = hi
  while (d - c > step) {
    const mid = roundTo((c + d) / 2, step)
    if (mid <= c || mid >= d) break
    if (await ask(mid)) c = mid
    else d = mid
  }
  const max = c

  return { ok: true, min, max, checks }
}

async function readExpectation(options) {
  const raw = await renderPage({
    url: PROFILE_URL,
    evaluate: READ_SCRIPT,
    timeoutMs: options.timeoutMs ?? 45000,
    settleMs: 3500,
    profile: options.profile,
    executable: options.executable,
  })
  const parsed = parseJson(raw)
  if (!parsed?.ok) return { ok: false, reason: parsed?.reason ?? 'E_PROFILE_READ' }
  const amount = Number(String(parsed.value).replace(/[^\d.]/g, ''))
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'E_PROFILE_READ' }
  return { ok: true, amount, type: parsed.type || 'Annual' }
}

async function setExpectation(amount, type, options) {
  const raw = await renderPage({
    url: PROFILE_URL,
    evaluate: editScript(amount, type),
    timeoutMs: options.timeoutMs ?? 45000,
    settleMs: 3500,
    profile: options.profile,
    executable: options.executable,
  })
  return Boolean(parseJson(raw)?.ok)
}

async function badgeAtWithProfile(job, annual, options) {
  const [editRaw, badgeRaw] = await renderSteps({
    profile: options.profile,
    executable: options.executable,
    timeoutMs: options.timeoutMs ?? 45000,
    steps: [
      { url: PROFILE_URL, evaluate: editScript(annual), settleMs: 3200 },
      { url: job.url, evaluate: BADGE_SCRIPT, settleMs: 3200 },
    ],
  })
  const edit = parseJson(editRaw)
  if (!edit?.ok) throw Object.assign(new Error(`改期望薪资失败：${edit?.reason ?? 'unknown'}`), { code: 'E_PROFILE_EDIT' })
  const badge = parseJson(badgeRaw)
  if (badge?.blocked) throw Object.assign(new Error('JobsDB 弹了验证页'), { code: 'E_BLOCKED' })
  if (!badge) throw Object.assign(new Error('详情页没读到徽章状态'), { code: 'E_BADGE_READ' })
  return Boolean(badge.badge)
}

/**
 * 主流程：读原期望 → 用粗区间做二分 → 恢复原期望。
 * 返回 { ok, salary, checks, minAnnual, maxAnnual, restored }。
 */
export async function preciseSalary(job, options = {}) {
  const id = String(job?.nativeId ?? job?.id ?? '')
  const url = String(job?.url ?? '') || (id ? `https://hk.jobsdb.com/job/${id}` : '')
  if (!id || !url) return { ok: false, reason: 'E_BAD_PARAM' }

  const cache = await readCache(options.dataDir)
  const hit = cache[id]
  if (hit && Date.now() - (hit.at ?? 0) < CACHE_TTL_MS && hit.salary) {
    return { ok: true, cached: true, salary: hit.salary, checks: 0, ms: 0 }
  }

  const original = await readExpectation(options)
  if (!original.ok) return { ok: false, reason: original.reason ?? 'E_PROFILE_READ' }

  // 没有现成档位就先跑一次 5k 档位探针，用它做粗区间；比从 6 万扫到 120 万便宜得多。
  let bands = Array.isArray(job?.salary?.evidence?.bands) ? job.salary.evidence.bands : []
  if (bands.length === 0) {
    const probe = await probeSalary(job, { dataDir: options.dataDir, gapMs: 250 })
    if (probe.ok) bands = probe.bands ?? []
  }

  const { low, high } = boundsFrom(job, bands)
  const started = Date.now()
  let outcome
  let restoreError = null
  try {
    const result = await bisectRange({
      low,
      high,
      badgeAt: (annual) => badgeAtWithProfile({ ...job, url }, annual, options),
    })
    if (!result.ok) {
      outcome = { ok: false, reason: result.reason, checks: result.checks }
    } else {
      const min = Math.max(1000, Math.round(result.min / 12 / 100) * 100)
      const max = Math.max(min, Math.round(result.max / 12 / 100) * 100)
      const salary = {
        currency: 'HKD',
        period: 'month',
        min,
        max,
        mid: Math.round((min + max) / 2),
        openEnded: false,
        label: '',
        bonus: '',
        kind: 'probed',
        confidence: 'A',
        source: 'platform-match',
        evidence: {
          platform: 'jobsdb',
          method: 'salary-match-bisect',
          checks: result.checks,
          minAnnual: result.min,
          maxAnnual: result.max,
          at: new Date().toISOString(),
        },
      }
      cache[id] = { at: Date.now(), salary }
      await writeCache(options.dataDir, cache)
      outcome = { ok: true, cached: false, salary, checks: result.checks, minAnnual: result.min, maxAnnual: result.max, ms: Date.now() - started }
    }
  } catch (error) {
    outcome = { ok: false, reason: error?.code ?? 'E_PRECISE_FAILED', message: String(error?.message ?? error).slice(0, 200) }
  } finally {
    const ok = await setExpectation(original.amount, original.type, options).catch(() => false)
    if (!ok) restoreError = `没能恢复原期望薪资（${original.amount} ${original.type}），请在 JobsDB 资料页手动改回`
  }

  if (outcome) {
    outcome.restored = !restoreError
    if (restoreError) outcome.restoreError = restoreError
    outcome.original = { amount: original.amount, type: original.type }
  }
  return outcome
}
