import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

async function cli(ctx, command, input, timeoutMs) {
  const { exitCode, result, stderr } = await ctx.runCli(command, input, timeoutMs)
  return result ?? { ok: false, code: 'E_INTERNAL', message: stderr || `cli exit ${exitCode}` }
}

export const routes = [
  {
    method: 'GET',
    path: '/api/health',
    public: true,
    handler: (ctx, request, response) => ctx.sendJson(response, 200, { ok: true, version: ctx.version, dataDir: ctx.dataDir }),
  },
  {
    method: 'GET',
    path: '/api/sources',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await cli(ctx, 'sources', {})),
  },
  {
    method: 'GET',
    path: '/api/locations',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await cli(ctx, 'locations', {})),
  },
  {
    method: 'GET',
    path: '/api/probe',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await cli(ctx, 'probe', {}, 240000)),
  },
  {
    method: 'GET',
    path: '/api/session',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await cli(ctx, 'session', {}, 60000)),
  },
  {
    method: 'POST',
    path: '/api/browser-login',
    handler: async (ctx, request, response) => {
      const body = await ctx.readJson(request)
      ctx.sendJson(response, 200, await cli(ctx, 'browser-login', body, 600000))
    },
  },
  {
    method: 'GET',
    path: '/api/latest',
    handler: async (ctx, request, response) => {
      const file = join(ctx.dataDir, 'latest.json')
      if (!existsSync(file)) return ctx.sendJson(response, 404, { ok: false, code: 'E_RUN_NOT_FOUND', message: '还没有报告' })
      ctx.sendJson(response, 200, JSON.parse(await readFile(file, 'utf8')))
    },
  },
  {
    method: 'GET',
    path: '/api/translations',
    handler: async (ctx, request, response) => {
      const file = join(ctx.dataDir, 'translations.json')
      if (!existsSync(file)) return ctx.sendJson(response, 200, { ok: true, map: {} })
      ctx.sendJson(response, 200, { ok: true, map: JSON.parse(await readFile(file, 'utf8')) })
    },
  },
]
