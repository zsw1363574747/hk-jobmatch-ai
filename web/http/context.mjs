import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

export const MAX_BODY = 5 * 1024 * 1024
export const UPLOAD_MAX = 5 * 1024 * 1024
export const UPLOAD_EXTS = new Set(['.pdf', '.docx', '.txt', '.md'])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

export function readBody(request, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'E_BAD_PARAM' }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

export function readRaw(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        reject(Object.assign(new Error('upload too large'), { code: 'E_UI_UPLOAD_TOO_LARGE' }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!settled) {
        settled = true
        resolve(Buffer.concat(chunks))
      }
    })
    request.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

export function createContext({ publicDir, cli, dataDir, token, version, port, host }) {
  async function runCli(command, input, timeoutMs = 180000) {
    await mkdir(join(dataDir, '.tmp'), { recursive: true })
    const requestFile = join(dataDir, '.tmp', `req-${randomBytes(4).toString('hex')}.json`)
    await writeFile(requestFile, JSON.stringify(input ?? {}), 'utf8')
    // 本机可能有企业代理/杀软在做 TLS 中间人，Node 自带根证书认不出来；
    // --use-system-ca 让 Node 用系统证书库。Node < 22.15 没有这个 flag，跳过。
    const nodeFlags = process.allowedNodeEnvironmentFlags.has('--use-system-ca') ? ['--use-system-ca'] : []
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [...nodeFlags, cli, command, '--input-file', requestFile, '--data-dir', dataDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const line = stdout.trim().split('\n').pop() ?? ''
        let parsed = null
        try {
          parsed = line ? JSON.parse(line) : null
        } catch {
          parsed = null
        }
        resolve({ exitCode: code, result: parsed, stderr: stderr.slice(-2000) })
      })
    })
  }

  function authorized(request) {
    if (request.headers['x-jobmatch-token'] !== token) return false
    const origin = request.headers.origin
    return !origin || origin === `http://${host}:${port}`
  }

  async function serveStatic(request, response, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
    if (relative.includes('..')) return sendJson(response, 403, { ok: false, code: 'E_BAD_PARAM' })
    const file = join(publicDir, relative)
    if (!existsSync(file)) return sendJson(response, 404, { ok: false, code: 'E_NOT_FOUND', message: '页面不存在' })
    const body = await readFile(file)
    if (relative === 'index.html') {
      const html = body.toString('utf8').replace('__JOBMATCH_BOOT__', JSON.stringify({ token, version }))
      response.writeHead(200, { 'content-type': MIME['.html'], 'content-length': Buffer.byteLength(html) })
      response.end(html)
      return
    }
    response.writeHead(200, {
      'content-type': MIME[extname(relative)] ?? 'application/octet-stream',
      'content-length': body.length,
    })
    response.end(body)
  }

  /** 解析成功就把画像落盘：刷新页面不用重新上传简历。 */
  async function saveProfile(result) {
    if (!result?.ok || !result.profile) return
    const payload = {
      savedAt: new Date().toISOString(),
      source: result.source ?? null,
      textChars: result.textChars ?? String(result.text ?? '').length,
      profile: result.profile,
      text: typeof result.text === 'string' ? result.text.slice(0, 20000) : '',
    }
    await writeFile(join(dataDir, 'profile.json'), JSON.stringify(payload, null, 2), 'utf8').catch(() => {})
  }

  async function readJson(request) {
    const raw = await readBody(request)
    return raw ? JSON.parse(raw) : {}
  }

  return {
    dataDir,
    token,
    version,
    host,
    port,
    publicDir,
    runCli,
    authorized,
    serveStatic,
    saveProfile,
    sendJson,
    readBody,
    readRaw,
    readJson,
  }
}
