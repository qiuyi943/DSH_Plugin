/**
 * Why does the conversation API answer `460004 机器人不存在`?
 *
 * Sends the resolved AppKey to every candidate chat host, then inspects the app's
 * release channels, which are the other place a conversation credential can live.
 *
 *   node test/chatprobe.mjs <appId>
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITES, buildTc3Headers } from '../lib/impl.js'

const here = dirname(fileURLToPath(import.meta.url))
const appId = process.argv[2]
if (appId === undefined) {
  console.log('用法：node test/chatprobe.mjs <appId>')
  process.exit(1)
}

const statePath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'adp-console', 'state.json')
const stored = JSON.parse(await readFile(statePath, 'utf8')).credentials ?? {}
const patchSite = /^\s*site:\s*(\S+)\s*$/m.exec(await readFile(join(here, '..', 'cordis.patch.yml'), 'utf8'))?.[1]
const site = stored.site || patchSite || 'cn'
const endpoint = SITES[site]?.endpoint ?? SITES.cn.endpoint
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

/** First AppKey-ish string in a value. */
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

const app = await call('DescribeApp', { AppId: appId, FieldMask: { Paths: ['SecretInfo'] } })
const appKey = findAppKey(app)

/** One conversation probe against a chat host. */
async function probeChat(label, url, fields) {
  const id = 'probe' + Date.now().toString(16).padEnd(27, '0')
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        RequestId: id,
        ConversationId: id,
        Contents: [{ Type: 'text', Text: '你好' }],
        Stream: 'enable',
        Incremental: true,
        ...fields,
      }),
    })
    const text = await response.text()
    const code = /"Code":([^,}]+)/.exec(text)?.[1]
    const message = /"Message":"([^"]*)"/.exec(text)?.[1]
    const verdict = code === undefined ? 'no error event' : `${code} ${message ?? ''}`
    console.log(`  [${label}] HTTP ${response.status} → ${verdict}`)
  } catch (error) {
    console.log(`  [${label}] 传输失败 ${error.message}`)
  }
}

console.log(`appId : ${appId}`)
console.log(`AppKey: ${appKey === undefined ? '(none)' : `${appKey.slice(0, 4)}…${appKey.slice(-4)} (len ${appKey.length})`}\n`)

console.log('同一个 AppKey 打不同对话地址：')
await probeChat('独立站 adp.tencent.com', SITES.standalone.chatEndpoint, { AppKey: appKey, VisitorId: 'dsh-probe', UserId: 'dsh-probe' })
await probeChat('云站 wss.lke.cloud', SITES.cn.chatEndpoint, { AppKey: appKey, VisitorId: 'dsh-probe', UserId: 'dsh-probe' })
await probeChat('云站(仅 VisitorId)', SITES.cn.chatEndpoint, { AppKey: appKey, VisitorId: 'dsh-probe' })

console.log('\n该应用的渠道：')
try {
  const channels = await call('DescribeChannelList', { AppId: appId, PageNumber: 0, PageSize: 20 })
  const list = channels.ChannelList ?? channels.ChannelSummaryList ?? []
  console.log(`  TotalCount=${channels.TotalCount ?? '?'} 数量=${Array.isArray(list) ? list.length : '?'}`)
  for (const channel of Array.isArray(list) ? list : []) {
    const masked = Object.fromEntries(Object.entries(channel).map(([key, value]) => [
      key,
      typeof value === 'string' && value.length > 24 ? `${value.slice(0, 4)}…${value.slice(-4)} (len ${value.length})` : value,
    ]))
    console.log(`  · ${JSON.stringify(masked)}`)
  }
} catch (error) {
  console.log(`  DescribeChannelList 失败：${error.message}`)
}

console.log('\n最新发布详情：')
try {
  const release = await call('DescribeLatestRelease', { AppId: appId })
  console.log(`  ${JSON.stringify(release.ReleaseSummary)}`)
} catch (error) {
  console.log(`  失败：${error.message}`)
}
