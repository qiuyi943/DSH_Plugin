/**
 * Which `Domain` yields the AppKey the conversation API accepts?
 *
 * `DescribeApp.Domain`: 1 = 开发域, 2 = 发布域/生产域. The conversation docs say the
 * AppKey comes from an app in the running state "（需要先发布）", which points at the
 * published domain.
 *
 *   node test/appkey.mjs <appId> [--chat]
 *
 * Prints masked keys only; `--chat` additionally sends one probe message.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITES, buildTc3Headers } from '../lib/impl.js'

const here = dirname(fileURLToPath(import.meta.url))
const appId = process.argv[2]
const wantChat = process.argv.includes('--chat')
if (appId === undefined) {
  console.log('用法：node test/appkey.mjs <appId> [--chat]')
  process.exit(1)
}

const statePath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'adp-console', 'state.json')
const stored = JSON.parse(await readFile(statePath, 'utf8')).credentials ?? {}
const patchSite = /^\s*site:\s*(\S+)\s*$/m.exec(await readFile(join(here, '..', 'cordis.patch.yml'), 'utf8'))?.[1]
const site = stored.site || patchSite || 'cn'
const endpoint = SITES[site]?.endpoint ?? SITES.cn.endpoint
const chatEndpoint = SITES[site]?.chatEndpoint ?? SITES.cn.chatEndpoint
const region = stored.region || 'ap-guangzhou'

/** Call one ADP action. */
async function call(action, params) {
  const timestamp = Math.floor(Date.now() / 1000)
  const { headers, body } = buildTc3Headers({
    secretId: stored.secretId, secretKey: stored.secretKey, endpoint, service: 'adp',
    action, version: '2026-05-20', region, payload: params, timestamp,
  })
  const response = await fetch(`https://${endpoint}/`, { method: 'POST', headers, body })
  const parsed = JSON.parse(await response.text())
  if (parsed.Response?.Error) throw new Error(`${parsed.Response.Error.Code} — ${parsed.Response.Error.Message}`)
  return parsed.Response
}

/** Find the first AppKey-ish string. */
function findAppKey(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return undefined
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && child !== '' && /^app_?key$/i.test(key)) return child
    const nested = findAppKey(child, seen)
    if (nested !== undefined) return nested
  }
  return undefined
}

const mask = value => (value === undefined ? '(none)' : `${value.slice(0, 4)}…${value.slice(-4)} (len ${value.length})`)

console.log(`site        : ${site} (${SITES[site]?.label})`)
console.log(`appId       : ${appId}`)
console.log(`chatEndpoint: ${chatEndpoint}\n`)

try {
  const release = await call('DescribeLatestRelease', { AppId: appId })
  const summary = release.ReleaseSummary
  console.log(`最新发布      : ReleaseId=${summary?.ReleaseId ?? '(none)'} Status=${summary?.Status ?? '(none)'} ${summary?.StatusDescription ?? ''}`)
  console.log(`是否有变更    : IsChanged=${release.IsChanged}\n`)
} catch (error) {
  console.log(`DescribeLatestRelease 失败: ${error.message}\n`)
}

const keys = {}
for (const domain of [undefined, 1, 2]) {
  const label = domain === undefined ? '未传 Domain' : domain === 1 ? 'Domain=1 开发域' : 'Domain=2 发布域'
  try {
    const app = await call('DescribeApp', {
      AppId: appId,
      ...(domain === undefined ? {} : { Domain: domain }),
      FieldMask: { Paths: ['SecretInfo'] },
    })
    const key = findAppKey(app)
    keys[label] = key
    console.log(`${label.padEnd(16)}: AppKey ${mask(key)}`)
  } catch (error) {
    console.log(`${label.padEnd(16)}: 失败 ${error.message}`)
  }
}

const distinct = new Set(Object.values(keys).filter(value => value !== undefined))
console.log(`\n不同的 AppKey 个数：${distinct.size}`)

if (process.argv.includes('--dump')) {
  const app = await call('DescribeApp', { AppId: appId, FieldMask: { Paths: ['SecretInfo', 'ShareUrlInfo'] } })
  /** Mask every string that looks like a secret, keep the structure readable. */
  const maskDeep = (value, depth = 0) => {
    if (depth > 4) return '…'
    if (typeof value === 'string') {
      return value.length > 24 ? `${value.slice(0, 4)}…${value.slice(-4)} (len ${value.length})` : value
    }
    if (Array.isArray(value)) return value.map(item => maskDeep(item, depth + 1))
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, maskDeep(child, depth + 1)]))
    }
    return value
  }
  console.log('\n--- DescribeApp(App) 结构（长字符串已掩码） ---')
  console.log(JSON.stringify(maskDeep(app), null, 2))
}

if (!wantChat) {
  console.log('加 --chat 可用每个 AppKey 各发一条探测消息；加 --dump 打印 DescribeApp 结构。')
  process.exit(0)
}

for (const [label, key] of Object.entries(keys)) {
  if (key === undefined) continue
  const requestId = 'probe' + Date.now().toString(16).padEnd(27, '0')
  const response = await fetch(chatEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      RequestId: requestId,
      ConversationId: requestId,
      AppKey: key,
      VisitorId: 'dsh-probe',
      UserId: 'dsh-probe',
      Contents: [{ Type: 'text', Text: '你好' }],
      Stream: 'enable',
      Incremental: true,
    }),
  })
  const text = await response.text()
  const verdict = text.includes('"Type":"error"')
    ? `error ${/"Code":([^,}]+)/.exec(text)?.[1] ?? '?'} ${/"Message":"([^"]*)"/.exec(text)?.[1] ?? ''}`
    : 'no error event (looks usable)'
  console.log(`\n[${label}] HTTP ${response.status} → ${verdict}`)
}
