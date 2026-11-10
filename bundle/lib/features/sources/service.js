import { fail } from '../../errors.js'
import { browserStatus, openWindow } from '../../sources/browser.js'
import { listSources, probeSources } from '../../sources/index.js'
import { checkLogin } from '../../sources/session.js'

/** 列出所有来源 + 浏览器是否可用（UI 的开关就按这个渲染）。 */
export function sources() {
  return { ok: true, browser: browserStatus(), sources: listSources() }
}

/** 逐站自检：现在哪个站通、哪个被拦，一次说清楚。 */
export async function probe(options = {}) {
  const started = Date.now()
  const rows = await probeSources({ executable: options.executable, profile: options.profile })
  return { ok: true, ms: Date.now() - started, rows, browser: browserStatus() }
}

/** 登录态：决定能不能用「薪酬相符」徽章。 */
export async function session(options = {}) {
  const login = await checkLogin({ executable: options.executable, profile: options.profile })
  return { ok: true, ...login, browser: browserStatus() }
}

/** 开一个可见窗口，人工过一次验证（cookie 留在 profile 里）。 */
export async function browserLogin(input = {}, options = {}) {
  const siteMap = {
    jobsdb: 'https://hk.jobsdb.com',
    govhk: 'https://www.jobs.gov.hk/0',
    ctgoodjobs: 'https://jobs.ctgoodjobs.hk',
    linkedin: 'https://www.linkedin.com/login',
    indeed: 'https://hk.indeed.com',
  }
  const id = String(input.site ?? input.id ?? '').trim().toLowerCase()
  const url = String(input.url ?? siteMap[id] ?? '')
  if (!url) throw Object.assign(fail('E_BAD_PARAM'), { step: 'browserLogin', expected: Object.keys(siteMap).join('|') })
  const result = await openWindow(url, { seconds: input.seconds, executable: options.executable, profile: options.profile })
  return { ok: true, site: id, url, ...result }
}
