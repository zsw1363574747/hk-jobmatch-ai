async function run(ctx, command, input, timeoutMs) {
  const { exitCode, result, stderr } = await ctx.runCli(command, input, timeoutMs)
  return result ?? { ok: false, code: 'E_INTERNAL', message: stderr || `cli exit ${exitCode}` }
}

export const routes = [
  {
    method: 'POST',
    path: '/api/jobs',
    handler: async (ctx, request, response) => {
      // all=true 时可能要补全本轮全部 JD（几十条），给足时间。
      ctx.sendJson(response, 200, await run(ctx, 'jobs', await ctx.readJson(request), 600000))
    },
  },
  {
    method: 'POST',
    path: '/api/jd',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await run(ctx, 'jd', await ctx.readJson(request))),
  },
  {
    method: 'POST',
    path: '/api/translate',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await run(ctx, 'translate', await ctx.readJson(request))),
  },
  {
    method: 'GET',
    path: '/api/news',
    handler: async (ctx, request, response, url) => {
      const company = String(url.searchParams.get('company') ?? '').trim()
      if (!company) return ctx.sendJson(response, 400, { ok: false, code: 'E_BAD_PARAM', message: '缺 company' })
      const limit = Number(url.searchParams.get('limit')) || 10
      ctx.sendJson(response, 200, await run(ctx, 'news', { company, limit }))
    },
  },
  {
    method: 'GET',
    path: '/api/insight',
    handler: async (ctx, request, response, url) => {
      const runId = String(url.searchParams.get('runId') ?? '').trim()
      if (!runId) return ctx.sendJson(response, 400, { ok: false, code: 'E_BAD_PARAM', message: '缺 runId' })
      // scope=all：合并 data/runs 里所有轮次（按岗位去重），样本比单轮大。
      const allRuns = url.searchParams.get('scope') === 'all'
      ctx.sendJson(response, 200, await run(ctx, 'insight', { runId, allRuns }, 120000))
    },
  },
  {
    method: 'POST',
    path: '/api/salary',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await run(ctx, 'salary', await ctx.readJson(request), 120000)),
  },
  {
    method: 'POST',
    path: '/api/salary-precise',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await run(ctx, 'salary-precise', await ctx.readJson(request), 900000)),
  },
  {
    method: 'POST',
    path: '/api/salary-report',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await run(ctx, 'salary-report', await ctx.readJson(request), 180000)),
  },
  {
    // 按 JD 年限分档的明码薪资：每条都要抓一次 JD，给足时间。
    method: 'POST',
    path: '/api/salary-bands',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await run(ctx, 'salary-bands', await ctx.readJson(request), 900000)),
  },
]
