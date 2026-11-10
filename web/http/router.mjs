import { routes as systemRoutes } from '../routes/system.mjs'
import { routes as profileRoutes } from '../routes/profile.mjs'
import { routes as resumeRoutes } from '../routes/resume.mjs'
import { routes as searchRoutes } from '../routes/search.mjs'
import { routes as jobsRoutes } from '../routes/jobs.mjs'
import { routes as reportRoutes } from '../routes/report.mjs'

const ROUTES = [...systemRoutes, ...profileRoutes, ...resumeRoutes, ...searchRoutes, ...jobsRoutes, ...reportRoutes]

function matchPath(pattern, pathname) {
  if (!pattern.includes(':')) return pattern === pathname ? {} : null
  const expected = pattern.split('/')
  const actual = pathname.split('/')
  if (expected.length !== actual.length) return null
  const params = {}
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].startsWith(':')) {
      params[expected[index].slice(1)] = actual[index]
      continue
    }
    if (expected[index] !== actual[index]) return null
  }
  return params
}

export async function handle(request, response, url, ctx) {
  const { pathname } = url

  if (request.method === 'GET' && !pathname.startsWith('/api/')) {
    return ctx.serveStatic(request, response, pathname)
  }

  let pathMatched = false
  for (const route of ROUTES) {
    const params = matchPath(route.path, pathname)
    if (!params) continue
    pathMatched = true
    if (route.method !== request.method) continue

    const tokenOk = route.tokenQuery && url.searchParams.get('token') === ctx.token
    if (!route.public && !tokenOk && !ctx.authorized(request)) {
      return ctx.sendJson(response, 403, { ok: false, code: 'E_UI_TOKEN', message: '缺少或错误的 token', hint: '刷新页面重新加载服务' })
    }

    try {
      await route.handler(ctx, request, response, url, params)
    } catch (error) {
      if (response.headersSent) return response.end()
      return ctx.sendJson(response, 500, {
        ok: false,
        code: error?.code ?? 'E_INTERNAL',
        message: String(error?.message ?? error).slice(0, 200),
      })
    }
    return
  }

  if (pathMatched) {
    return ctx.sendJson(response, 405, { ok: false, code: 'E_BAD_PARAM', message: '不支持的方法' })
  }
  return ctx.sendJson(response, 404, { ok: false, code: 'E_NOT_FOUND', message: '没有这个接口' })
}
