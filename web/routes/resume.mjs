import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { UPLOAD_EXTS, UPLOAD_MAX } from '../http/context.mjs'

export const routes = [
  {
    method: 'PUT',
    path: '/api/resume/upload',
    handler: async (ctx, request, response, url) => {
      const name = String(url.searchParams.get('name') ?? '').trim()
      const ext = extname(name).toLowerCase()
      if (!UPLOAD_EXTS.has(ext)) {
        return ctx.sendJson(response, 400, { ok: false, code: 'E_UI_FILE_TYPE', message: '只支持 .pdf / .docx / .txt / .md' })
      }

      let raw
      try {
        raw = await ctx.readRaw(request, UPLOAD_MAX)
      } catch (error) {
        const tooLarge = error?.code === 'E_UI_UPLOAD_TOO_LARGE'
        return ctx.sendJson(response, tooLarge ? 413 : 400, {
          ok: false,
          code: tooLarge ? 'E_UI_UPLOAD_TOO_LARGE' : 'E_UI_BAD_UPLOAD',
          message: tooLarge ? '文件超过 5 MB，改用本机路径' : '上传失败',
        })
      }
      if (raw.length === 0) {
        return ctx.sendJson(response, 400, { ok: false, code: 'E_UI_BAD_UPLOAD', message: '空文件' })
      }

      const dir = join(ctx.dataDir, 'uploads')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}${ext}`)
      await writeFile(file, raw)
      try {
        const { exitCode, result, stderr } = await ctx.runCli('resume', { path: file })
        await ctx.saveProfile(result)
        ctx.sendJson(response, 200, result ?? { ok: false, code: 'E_INTERNAL', message: stderr || `cli exit ${exitCode}` })
      } finally {
        await unlink(file).catch(() => {})
      }
    },
  },
  {
    method: 'POST',
    path: '/api/resume',
    handler: async (ctx, request, response) => {
      const input = await ctx.readJson(request)
      const { exitCode, result, stderr } = await ctx.runCli('resume', input)
      await ctx.saveProfile(result)
      ctx.sendJson(response, 200, result ?? { ok: false, code: 'E_INTERNAL', message: stderr || `cli exit ${exitCode}` })
    },
  },
]
