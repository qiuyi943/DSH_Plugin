/**
 * Run the plugin's own conversation path against a real app.
 *
 * Exercises `runAdpChat` exactly as the tool and the panel do, including the
 * SSE → WebSocket fallback, and prints which transport answered.
 *
 *   node test/chat.mjs <appId> ["message"]
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdpError, SITES, buildTc3Headers, runAdpChat } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const appId = process.argv[2]
if (appId === undefined) {
  console.log('用法：node test/chat.mjs <appId> ["消息"]')
  process.exit(1)
}
const message = process.argv[3] ?? '你好，请用一句话介绍你自己'

const statePath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'adp-console', 'state.json')
const stored = JSON.parse(await readFile(statePath, 'utf8')).credentials ?? {}
const patchSite = /^\s*site:\s*(\S+)\s*$/m.exec(await readFile(join(here, '..', 'cordis.patch.yml'), 'utf8'))?.[1]
const site = stored.site || process.env.DSH_ADP_SITE || patchSite || 'cn'
const siteConfig = SITES[site] ?? SITES.cn
const endpoint = siteConfig.endpoint
const apiVersion = '2026-05-20'
const region = stored.region || 'ap-guangzhou'
const userId = process.env.DSH_ADP_USER_ID || 'dsh-user-001'

/** Signed management call. */
async function call(action, params) {
  const timestamp = Math.floor(Date.now() / 1000)
  const { headers, body } = buildTc3Headers({
    secretId: stored.secretId, secretKey: stored.secretKey, endpoint, service: 'adp',
    action, version: apiVersion, region, payload: params, timestamp,
  })
  const response = await fetch(`https://${endpoint}/`, { method: 'POST', headers, body })
  const parsed = await response.json()
  if (parsed.Response?.Error) {
    throw new AdpError(`${parsed.Response.Error.Code} — ${parsed.Response.Error.Message}`, { code: parsed.Response.Error.Code })
  }
  return parsed.Response
}

const appKey = (await call('DescribeApp', { AppId: appId, FieldMask: { Paths: ['SecretInfo'] } })).App.SecretInfo.AppKey
console.log(`site      : ${site} (${siteConfig.label})`)
console.log(`appId     : ${appId}`)
console.log(`AppKey    : ${appKey.slice(0, 6)}…${appKey.slice(-4)} (len ${appKey.length})`)
console.log(`SSE       : ${siteConfig.chatEndpoint}`)
console.log(`WS        : ${siteConfig.wsEndpoint}`)
console.log(`\n—— 回复 ——`)

const started = Date.now()
const seen = new Set()
const result = await runAdpChat({
  transport: process.env.DSH_ADP_TRANSPORT || 'auto',
  endpoint: siteConfig.chatEndpoint,
  wsEndpoint: siteConfig.wsEndpoint,
  appKey,
  message,
  userId,
  onEvent: (name, _payload, text) => {
    seen.add(name)
    if (text) process.stdout.write(text)
  },
  openConversation: async () => (await call('CreateConversation', {
    Type: 5, AppId: appId, AppKey: appKey, UserId: userId,
  })).ConversationId,
  openWebSocketToken: async () => (await call('CreateWebSocketToken', {
    Type: 5, AppId: appId, AppKey: appKey, UserId: userId,
  })).Token,
})

console.log('\n')
console.log(`传输通道 : ${result.transport}`)
console.log(`会话 ID  : ${result.conversationId}`)
console.log(`耗时     : ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`事件     : ${[...seen].join(', ')}`)
