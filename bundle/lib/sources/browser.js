/**
 * 零依赖浏览器驱动（CDP）。
 *
 * 为什么需要它：CTgoodjobs / LinkedIn / Indeed / OfferToday 这几家对
 * 纯 HTTP 请求要么返 403、405、451，要么直接丢 Cloudflare / AWS WAF 挑战页。
 * 它们的数据是前端渲染出来的，只有真的跑一遍 JS 才拿得到。
 *
 * 不装 puppeteer / playwright：本机 Edge（或 Chrome）自带，Node 内置 fetch +
 * 全局 WebSocket 就够说 CDP。整个文件只用 node: 内置模块。
 *
 * 用法：
 *   const html = await renderPage({ url, waitFor, timeoutMs, profile })
 * profile 是持久化目录 —— 第一次人工过验证（点一下）之后，cookie 留在里面，
 * 后续 headless 直接复用。
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const WIN = process.platform === 'win32'

function candidateBrowsers() {
  const list = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '') list.push(value)
  }
  push(process.env.JOBMATCH_BROWSER)
  if (WIN) {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA ?? ''
    push(join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    push(join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    push(join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    push(join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    if (local) push(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  } else if (process.platform === 'darwin') {
    push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else {
    push('/usr/bin/google-chrome')
    push('/usr/bin/chromium')
    push('/usr/bin/chromium-browser')
    push('/usr/bin/microsoft-edge')
  }
  return [...new Set(list)]
}

export function findBrowser() {
  for (const candidate of candidateBrowsers()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return await response.json()
    } catch (error) {
      lastError = error
    }
    await sleep(120)
  }
  throw new Error(`browser did not expose CDP on ${port}: ${lastError?.message ?? 'timeout'}`)
}

/** 最小 CDP 客户端：一条连接、自增 id、按 id 配对的 promise。 */
class Session {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id)
        clearTimeout(timer)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(`${message.error.message ?? 'cdp error'} (${message.error.code})`))
        else resolve(message.result)
        return
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cdp timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  once(predicate, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener)
        reject(new Error('cdp event timeout'))
      }, timeoutMs)
      const listener = (message) => {
        if (!predicate(message)) return
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(message)
      }
      this.listeners.add(listener)
    })
  }

  close() {
    try {
      this.socket.close()
    } catch {}
  }
}

function connect(wsUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), timeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('ws connect failed'))
    })
  })
}

export function defaultProfileDir() {
  return process.env.JOBMATCH_BROWSER_PROFILE ?? join(process.env.JOBMATCH_DATA_DIR ?? '.', 'browser-profile')
}

/**
 * 启动一个浏览器并连上 CDP，返回可复用的会话。
 * renderPage / renderPages 共用它：一次启动，多次导航。
 */
async function openBrowser(options = {}) {
  const executable = options.executable ?? findBrowser()
  if (!executable) throw new Error('没找到 Edge / Chrome；设 JOBMATCH_BROWSER 指向浏览器可执行文件')
  const headless = options.headless !== false
  const profile = options.profile ?? defaultProfileDir()
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 25000)
  await mkdir(profile, { recursive: true })

  const port = await freePort()
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--mute-audio',
    '--window-size=1440,1000',
    headless ? '--headless=new' : '--start-maximized',
    'about:blank',
  ]
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true })
  let session = null

  const close = async () => {
    session?.close()
    try {
      child.kill()
    } catch {}
    await sleep(300)
    if (!headless) {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
    await rm(join(profile, 'SingletonLock'), { force: true }).catch(() => {})
  }

  try {
    const version = await waitForEndpoint(port, 20000)
    const browserWs = version?.webSocketDebuggerUrl
    if (!browserWs) throw new Error('CDP 没给出 webSocketDebuggerUrl')

    let target = null
    try {
      const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      if (created.ok) target = await created.json()
    } catch {}
    if (!target) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((entry) => entry.type === 'page')
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('CDP 没有可用的 page target')

    const socket = await connect(target.webSocketDebuggerUrl)
    session = new Session(socket)
    await session.send('Page.enable')
    await session.send('Runtime.enable')
  } catch (error) {
    await close()
    throw error
  }

  return {
    session,
    close,
    timeoutMs,
    settleMs: Number.isFinite(options.settleMs) ? options.settleMs : 800,
  }
}

/** 导航到 url 并等渲染稳定（可选等某个选择器出现）。 */
async function navigateTo(session, url, { timeoutMs, settleMs, waitFor }) {
  const loaded = session.once((message) => message.method === 'Page.loadEventFired', timeoutMs)
  await session.send('Page.navigate', { url })
  await loaded.catch(() => {})
  await sleep(settleMs)
  if (!waitFor) return
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await session.send('Runtime.evaluate', {
      expression: `!!document.querySelector(${JSON.stringify(waitFor)})`,
      returnByValue: true,
    })
    if (probe?.result?.value === true) break
    await sleep(200)
  }
}

async function readHtml(session) {
  const html = await session.send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  })
  return String(html?.result?.value ?? '')
}

/**
 * 在同一个浏览器会话里连续走多步（每步可导航 + evaluate）。
 * 给「改资料 → 打开岗位页读标记」这种两步操作省一次浏览器启动。
 *
 * @param {object} options
 * @param {Array<{url:string, evaluate?:string, settleMs?:number, waitFor?:string}>} options.steps
 */
export async function renderSteps(options = {}) {
  const steps = Array.isArray(options.steps) ? options.steps : []
  if (steps.length === 0) return []
  const browser = await openBrowser(options)
  const results = []
  try {
    for (const step of steps) {
      await navigateTo(browser.session, step.url, {
        timeoutMs: browser.timeoutMs,
        settleMs: step.settleMs ?? browser.settleMs,
        waitFor: step.waitFor,
      })
      if (step.evaluate) {
        const result = await browser.session.send(
          'Runtime.evaluate',
          { expression: String(step.evaluate), returnByValue: true, awaitPromise: true },
          Math.max(30000, browser.timeoutMs),
        )
        results.push(result?.result?.value ?? null)
      } else {
        results.push(await readHtml(browser.session))
      }
    }
    return results
  } finally {
    await browser.close()
  }
}

/**
 * 打开一个页面，等它渲染完，返回 outerHTML。
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.waitFor]   CSS 选择器；出现即认为渲染完成
 * @param {number} [options.timeoutMs] 总超时（默认 25s）
 * @param {string} [options.profile]   持久化用户目录（复用 cookie / 已过验证的站点）
 * @param {boolean} [options.headless] 默认 true；false 时弹窗口，用于人工过验证
 * @param {number} [options.settleMs]  渲染后再等一会儿（懒加载），默认 800
 */
export async function renderPage(options = {}) {
  const url = String(options.url ?? '')
  if (!/^https?:\/\//i.test(url)) throw new Error('renderPage: bad url')
  const browser = await openBrowser(options)
  try {
    await navigateTo(browser.session, url, browser)
    if (options.evaluate) {
      const result = await browser.session.send(
        'Runtime.evaluate',
        { expression: String(options.evaluate), returnByValue: true, awaitPromise: true },
        Math.max(30000, browser.timeoutMs),
      )
      return result?.result?.value ?? null
    }
    if (options.screenshotPath) {
      if (options.settleBeforeShotMs) await sleep(Number(options.settleBeforeShotMs) || 400)
      const shot = await browser.session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(String(options.screenshotPath), Buffer.from(shot.data, 'base64'))
      return String(options.screenshotPath)
    }
    return await readHtml(browser.session)
  } finally {
    await browser.close()
  }
}

/**
 * 一次浏览器会话里连续打开多个页面，返回 [{ url, html, error? }]。
 * 详情页抓取用它：之前每条详情都启动一次浏览器，10 条要 40 秒以上。
 */
export async function renderPages(options = {}) {
  const urls = (options.urls ?? []).map((item) => String(item ?? '')).filter((item) => /^https?:\/\//i.test(item))
  if (urls.length === 0) return []
  const browser = await openBrowser({ ...options, settleMs: options.settleMs ?? 1500 })
  const pages = []
  try {
    for (const url of urls) {
      try {
        await navigateTo(browser.session, url, browser)
        pages.push({ url, html: await readHtml(browser.session) })
      } catch (error) {
        pages.push({ url, html: '', error: String(error?.message ?? error) })
      }
    }
    return pages
  } finally {
    await browser.close()
  }
}

/** 浏览器是否可用（UI 用来决定要不要显示「浏览器来源」开关）。 */
export function browserStatus() {
  const executable = findBrowser()
  return {
    ok: Boolean(executable),
    executable: executable ?? '',
    profile: defaultProfileDir(),
    hint: executable ? '' : '装 Edge/Chrome，或设 JOBMATCH_BROWSER 指向浏览器可执行文件',
  }
}

/**
 * 开一个可见窗口，让人工过一次验证（AWS WAF / Cloudflare / 登录）。
 * cookie 会留在持久化 profile 里，之后 headless 直接复用。
 * 窗口自己关掉，或者到秒数上限，就结束。
 */
export async function openWindow(url, options = {}) {
  const executable = options.executable ?? findBrowser()
  if (!executable) throw new Error('没找到 Edge / Chrome；设 JOBMATCH_BROWSER 指向浏览器可执行文件')
  if (!/^https?:\/\//i.test(String(url))) throw new Error('openWindow: bad url')
  const profile = options.profile ?? defaultProfileDir()
  await mkdir(profile, { recursive: true })
  const seconds = Math.max(30, Math.min(900, Number(options.seconds) || 180))

  const child = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      String(url),
    ],
    { stdio: 'ignore', windowsHide: false, detached: false },
  )

  const closed = new Promise((resolve) => {
    child.on('exit', () => resolve('closed'))
    child.on('error', () => resolve('error'))
  })
  const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), seconds * 1000))
  const reason = await Promise.race([closed, timer])
  if (reason === 'timeout') {
    try {
      child.kill()
    } catch {}
  }
  await sleep(500)
  await rm(join(profile, 'SingletonLock'), { force: true }).catch(() => {})
  return { ok: true, reason, profile, seconds }
}

export async function listProfiles() {
  const dir = defaultProfileDir()
  if (!existsSync(dir)) return []
  try {
    return (await readdir(dir)).slice(0, 20)
  } catch {
    return []
  }
}
