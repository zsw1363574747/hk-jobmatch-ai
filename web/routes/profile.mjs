import { existsSync } from 'node:fs'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const routes = [
  {
    method: 'GET',
    path: '/api/profile',
    handler: async (ctx, request, response) => {
      const file = join(ctx.dataDir, 'profile.json')
      if (!existsSync(file)) return ctx.sendJson(response, 200, { ok: false, code: 'E_PROFILE_NONE' })
      try {
        ctx.sendJson(response, 200, { ok: true, ...JSON.parse(await readFile(file, 'utf8')) })
      } catch {
        ctx.sendJson(response, 200, { ok: false, code: 'E_PROFILE_BAD' })
      }
    },
  },
  {
    method: 'DELETE',
    path: '/api/profile',
    handler: async (ctx, request, response) => {
      await unlink(join(ctx.dataDir, 'profile.json')).catch(() => {})
      ctx.sendJson(response, 200, { ok: true })
    },
  },
  {
    method: 'GET',
    path: '/api/runs',
    handler: async (ctx, request, response) => {
      const dir = join(ctx.dataDir, 'runs')
      if (!existsSync(dir)) return ctx.sendJson(response, 200, { ok: true, runs: [] })
      const files = (await readdir(dir)).filter((name) => name.endsWith('.json') && !name.includes('.report'))
      const runs = []
      for (const name of files.slice(-10).reverse()) {
        try {
          const run = JSON.parse(await readFile(join(dir, name), 'utf8'))
          const counts = { A: 0, B: 0, C: 0, X: 0 }
          for (const job of run.jobs ?? []) {
            if (job.tier && counts[job.tier] !== undefined) counts[job.tier] += 1
          }
          runs.push({ runId: run.runId, createdAt: run.createdAt, keywords: run.query?.keywords ?? [], counts })
        } catch {
          // 坏文件跳过
        }
      }
      ctx.sendJson(response, 200, { ok: true, runs })
    },
  },
]
