import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const routes = [
  {
    method: 'POST',
    path: '/api/report',
    handler: async (ctx, request, response) => {
      const input = await ctx.readJson(request)
      const { exitCode, result, stderr } = await ctx.runCli('report', input)
      ctx.sendJson(response, 200, result ?? { ok: false, code: 'E_INTERNAL', message: stderr || `cli exit ${exitCode}` })
    },
  },
  {
    method: 'GET',
    path: '/api/runs/:runId/report',
    tokenQuery: true,
    handler: async (ctx, request, response, url, params) => {
      const runId = decodeURIComponent(params.runId)
      const file = join(ctx.dataDir, 'runs', `${runId}.report.md`)
      if (!existsSync(file)) {
        return ctx.sendJson(response, 404, { ok: false, code: 'E_RUN_NOT_FOUND', message: '报告还没生成' })
      }
      const text = await readFile(file, 'utf8')
      response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-length': Buffer.byteLength(text) })
      response.end(text)
    },
  },
]
