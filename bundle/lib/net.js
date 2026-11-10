import { FETCH_TIMEOUT_MS, USER_AGENT } from './constants.js'
import { fail } from './errors.js'

const CHALLENGE = /Just a moment|challenge-platform|cf-browser-verification|cf_chl_opt/i

function isChallenge(body) {
  return typeof body === 'string' && body.length < 200000 && CHALLENGE.test(body)
}

/**
 * 唯一的联网出口：超时、429、非 2xx 归一成规格错误码。
 * 403 且返回 Cloudflare 挑战页时，额外带 blocked=true，方便上层退到兜底策略。
 */
export async function fetchText(url, options = {}) {
  const {
    timeoutMs = FETCH_TIMEOUT_MS,
    userAgent = USER_AGENT,
    fetchImpl = globalThis.fetch,
    headers = {},
    method = 'GET',
    body,
  } = options

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method,
      body,
      headers: { 'user-agent': userAgent, accept: 'text/html,application/json', ...headers },
      signal: controller.signal,
    })
    if (response.status === 429) {
      throw Object.assign(fail('E_RATE_LIMIT'), { step: 'fetchText' })
    }
    if (!response.ok) {
      let body = ''
      try {
        body = await response.text()
      } catch {}
      const error = Object.assign(fail('E_HTTP_STATUS'), { step: 'fetchText', expected: '2xx' })
      error.status = response.status
      if (isChallenge(body)) error.blocked = true
      throw error
    }
    return await response.text()
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw Object.assign(fail('E_TIMEOUT'), { step: 'fetchText' })
    }
    if (error && typeof error.code === 'string') throw error
    throw Object.assign(fail('E_NETWORK'), { step: 'fetchText' })
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options)
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(fail('E_PARSE_FAILED'), { step: 'fetchJson' })
  }
}
