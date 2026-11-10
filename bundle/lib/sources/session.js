/**
 * 登录态与「薪酬相符 / Salary match」标记。
 *
 * 背景：求职者资料里填了期望薪资后，JobsDB 会在岗位详情页给一个匹配标记。
 * 2026-11 实测：标记只在详情页（`data-automation="job-detail-salary-match"`），
 * 文案是 "Salary match" / "薪酬符合期望"；只在岗位薪资符合你的期望时出现，
 * 列表卡上没有。它只是二元判断，不会给出隐藏薪资的具体数字。
 *
 * 设计：补薪资时顺手渲染一次详情页（和探针并发），已登录且命中才写
 * expectedSalaryMatch=true；没登录 / 没命中就跳过，不阻断主流程。
 */
import { renderPage } from './browser.js'

const LOGIN_TTL_MS = 10 * 60 * 1000
let loginCache = { at: 0, value: null }

// 正常页面也会加载 /cdn-cgi/challenge-platform/... 脚本，所以不能拿它当验证页；
// 真正的挑战页特征是标题「Just a moment」和 cf-chl / _cf_chl_opt 这些标记。
const CHALLENGE_RE = /<title>\s*Just a moment|cf-chl-|cf-browser-verification|challenge-form|_cf_chl_opt/i

// 2026-11 实测登录后的头部：data-automation="account name" + "sign out" + 文本 "Sign out"；
// 未登录页同时会留一个隐藏的 "sign-in-register"，所以登录标记优先，别被它带偏。
const LOGGED_IN_MARKERS = [
  /data-automation="(?:accountMenu|profileMenu|myJobs|signedInAvatar|account menu|profile menu|my jobs|account name|sign out)"/i,
  />\s*(?:My profile|My jobs|Sign out|Log out|我的档案|我的檔案|我的职位|我的職位|登出|退出登录)\s*</i,
]

// 实测未登录首页用的是 data-automation="sign in"（带空格），不是 signIn。
const LOGGED_OUT_MARKERS = [
  /data-automation="sign[ -]?in"/i,
  />\s*(?:Sign in|Log in|登入|登录)\s*</i,
]

/** 纯函数：给一段 HTML，判断是不是验证页 / 登录态。离线自检也用它。 */
export function classifyLoginPage(html) {
  const text = String(html ?? '')
  if (CHALLENGE_RE.test(text)) return { blocked: true, loggedIn: false, signedIn: false, signedOut: false }
  const signedIn = LOGGED_IN_MARKERS.some((re) => re.test(text))
  // 登录标记优先：登录后的页面里仍可能藏着 "Sign in" 的移动端入口。
  const signedOut = !signedIn && LOGGED_OUT_MARKERS.some((re) => re.test(text))
  return { blocked: false, loggedIn: signedIn, signedIn, signedOut }
}

/** 看一眼是不是登录态（缓存 10 分钟）。 */
export async function checkLogin(options = {}) {
  if (loginCache.value && Date.now() - loginCache.at < LOGIN_TTL_MS) return loginCache.value
  let html = ''
  try {
    html = await renderPage({
      url: 'https://hk.jobsdb.com/',
      timeoutMs: options.timeoutMs ?? 25000,
      settleMs: 1200,
      profile: options.profile,
      executable: options.executable,
    })
  } catch (error) {
    const value = { ok: false, loggedIn: false, reason: 'E_BROWSER', detail: String(error?.message ?? error).slice(0, 120), checkedAt: new Date().toISOString() }
    loginCache = { at: Date.now(), value }
    return value
  }
  const page = classifyLoginPage(html)
  if (page.blocked) {
    const value = { ok: false, loggedIn: false, reason: 'E_BLOCKED', checkedAt: new Date().toISOString() }
    loginCache = { at: Date.now(), value }
    return value
  }
  const reason = page.loggedIn ? 'signed-in' : page.signedOut ? 'signed-out' : 'unknown'
  const value = {
    ok: true,
    loggedIn: page.loggedIn,
    reason,
    checkedAt: new Date().toISOString(),
  }
  loginCache = { at: Date.now(), value }
  return value
}

export function resetLoginCache() {
  loginCache = { at: 0, value: null }
}

/**
 * 找这条岗位的「薪酬相符 / Salary match」标记。
 *
 * 2026-11 实测：标记只在**岗位详情页**（`data-automation="job-detail-salary-match"`），
 * 列表卡上没有；而且只在「岗位薪资符合你资料里的期望薪资」时才出现。
 * 所以这里直接渲染详情页，一次请求同时判断登录态和徽章。
 *
 * @returns {{ok:boolean, match:boolean|null, evidence?:string, reason?:string}}
 */
export async function checkSalaryMatch(job, options = {}) {
  const url = String(job?.url ?? '') || (job?.nativeId ? `https://hk.jobsdb.com/job/${encodeURIComponent(job.nativeId)}` : '')
  if (!url) return { ok: false, match: null, reason: 'E_BAD_PARAM' }

  let html = ''
  try {
    html = await renderPage({
      url,
      timeoutMs: options.timeoutMs ?? 35000,
      settleMs: options.settleMs ?? 3000,
      profile: options.profile,
      executable: options.executable,
    })
  } catch (error) {
    return { ok: false, match: null, reason: 'E_BROWSER', evidence: String(error?.message ?? error).slice(0, 120) }
  }

  const page = classifyLoginPage(html)
  if (page.blocked) return { ok: false, match: null, reason: 'E_BLOCKED' }
  if (!page.loggedIn) return { ok: false, match: null, reason: 'NOT_LOGGED_IN' }

  const badge = html.match(/data-automation="job-detail-salary-match"[^>]*>([^<]{0,40})</i)
  if (badge) return { ok: true, match: true, evidence: (badge[1] || 'Salary match').trim() }

  return { ok: false, match: null, reason: 'NO_BADGE' }
}
