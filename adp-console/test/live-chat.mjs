/**
 * Drive the plugin's real chat path against a real ADP app.
 *
 * Builds the same fake Host context the self-test uses, runs `apply()` with the live
 * credentials, then POSTs to the plugin's own `/chat` route — so the SDK-backed
 * management calls, the SSE attempt, the WebSocket fallback and the event reducer are
 * all the production code paths. Needs a configured key in the plugin state file.
 *
 *   node test/live-chat.mjs <appId> ["message"]
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITES } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const appId = process.argv[2]
if (appId === undefined) {
  console.log('用法：node test/live-chat.mjs <appId> ["消息"]')
  process.exit(1)
}
const message = process.argv[3] ?? '你好，请用一句话介绍你自己'

const statePath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'adp-console', 'state.json')
const stored = JSON.parse(await readFile(statePath, 'utf8')).credentials ?? {}
if (!stored.secretId || !stored.secretKey) {
  console.log(`未配置密钥（${statePath}）。`)
  process.exit(1)
}
const patch = await readFile(join(here, '..', 'cordis.patch.yml'), 'utf8')
const site = stored.site ?? /^\s*site:\s*(\S+)\s*$/m.exec(patch)?.[1] ?? 'cn'

const mod = await import(new URL('../index.js', import.meta.url).href)

/* ---- the same fake Host surface the self-test builds ---- */
const routes = []
const webCtx = {
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
}
const ctx = {
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get: () => undefined,
  inject(dependencies, callback) {
    if (dependencies.includes('webServer')) callback(webCtx)
  },
  tools: { register: () => () => {} },
  async emit() {},
}

mod.apply(ctx, {
  site,
  region: stored.region || 'ap-guangzhou',
  spaceId: stored.spaceId || 'default_space',
  protocol: 'https',
  chatTransport: 'auto',
  statePath,
  exposeTools: false,
})

/** Minimal IncomingMessage. */
function fakeRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    on() {},
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

/** Minimal ServerResponse that streams SSE frames as they are written. */
function fakeResponse() {
  return {
    statusCode: 0, headers: {}, headersSent: false, chunks: [], on() {},
    writeHead(status, headers) { this.statusCode = status; this.headers = { ...this.headers, ...headers }; this.headersSent = true },
    write(chunk) {
      this.headersSent = true
      this.chunks.push(chunk)
      // Stream the human-readable answer while the turn runs.
      const text = String(chunk)
      if (text.startsWith('event: console.delta')) {
        const line = text.split('\n').find(part => part.startsWith('data: '))
        try { process.stdout.write(JSON.parse(line.slice(6)).text) } catch { /* ignore */ }
      }
    },
    end(chunk) { if (chunk !== undefined) this.chunks.push(chunk) },
  }
}

const route = routes[0]
if (route === undefined) {
  console.log('路由未注册。')
  process.exit(1)
}

console.log(`site      : ${site} (${SITES[site]?.label})`)
console.log(`appId     : ${appId}`)
console.log(`route     : ${route.path}`)
console.log(`useSdk    : ${process.env.DSH_ADP_NO_SDK === '1' ? '内置签名（DSH_ADP_NO_SDK）' : '官方 SDK 优先'}`)
console.log('\n—— 回复 ——')

const started = Date.now()
const res = fakeResponse()
await route.handler(fakeRequest('POST', `${route.path}/chat`, JSON.stringify({ appId, message })), res)

const raw = res.chunks.join('')
const meta = [...raw.matchAll(/event: console\.*done\ndata: (\{[^\n]*\})/g)].map(match => JSON.parse(match[1]))
const errors = [...raw.matchAll(/event: console\.error\ndata: (\{[^\n]*\})/g)].map(match => JSON.parse(match[1]))

console.log('\n')
if (errors.length > 0) console.log(`❌ 错误：${errors.map(item => item.error).join(' | ')}`)
for (const item of meta) {
  // A short answer can arrive only in the completion frame, with no `text.delta`, so
  // the final text is printed here too.
  if (item.text) console.log(`完整回复 : ${item.text}`)
  console.log(`传输通道 : ${item.transport}`)
  console.log(`会话 ID  : ${item.conversationId}`)
}
console.log(`耗时     : ${((Date.now() - started) / 1000).toFixed(1)}s`)
