// 本地网页服务：只负责启动、静态文件和路由分发；每个功能在 routes/*.mjs。
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { HOST, PORT as DEFAULT_PORT } from '../bundle/lib/constants.js'
import { createContext } from './http/context.mjs'
import { handle } from './http/router.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(HERE, 'public')
const CLI = join(HERE, '..', 'bundle', 'bin', 'cli.mjs')
const DATA_DIR = process.env.JOBMATCH_DATA_DIR ?? join(HERE, '..', 'data')
const TOKEN = randomBytes(16).toString('hex')
const VERSION = '0.8.0'
let PORT = Number(process.env.JOBMATCH_PORT ?? DEFAULT_PORT)

// 新克隆下来还没有 data/：启动时就建好，免得第一次存简历/缓存时静默失败。
mkdirSync(DATA_DIR, { recursive: true })

const context = createContext({
  publicDir: PUBLIC_DIR,
  cli: CLI,
  dataDir: DATA_DIR,
  token: TOKEN,
  version: VERSION,
  host: HOST,
  port: PORT,
})

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)
  handle(request, response, url, context).catch((error) => {
    if (response.headersSent) return response.end()
    response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: false, code: 'E_INTERNAL', message: String(error?.message ?? error).slice(0, 200) }))
  })
})

function tryListen(port, attempts = 10) {
  server.once('error', (error) => {
    if (error?.code === 'EADDRINUSE' && attempts > 0) {
      process.stdout.write(`端口 ${port} 被占用，换 ${port + 1}\n`)
      PORT = port + 1
      context.port = port + 1
      tryListen(port + 1, attempts - 1)
      return
    }
    process.stderr.write(`jobmatch web 启动失败: ${error?.message ?? error}\n`)
    process.exit(1)
  })
  server.listen(port, HOST, () => {
    if (!server.listening) return
    PORT = port
    context.port = port
    process.stdout.write(`jobmatch web http://${HOST}:${port}  data=${DATA_DIR}\n`)
  })
}

tryListen(PORT)
