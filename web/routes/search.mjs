async function run(ctx, command, input) {
  const { exitCode, result, stderr } = await ctx.runCli(command, input)
  return result ?? { ok: false, code: 'E_INTERNAL', message: stderr || `cli exit ${exitCode}` }
}

export const routes = [
  {
    method: 'POST',
    path: '/api/search',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await run(ctx, 'search', await ctx.readJson(request))),
  },
  {
    method: 'POST',
    path: '/api/rescore',
    handler: async (ctx, request, response) => ctx.sendJson(response, 200, await run(ctx, 'rescore', await ctx.readJson(request))),
  },
]
