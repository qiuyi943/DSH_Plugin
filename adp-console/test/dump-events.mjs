/**
 * Dump every conversation frame verbatim.
 *
 * The panel only surfaces text today, so when an agent returns a human-in-the-loop
 * component (options, forms, cards) the content is silently dropped. This prints the
 * raw protocol so the real shape can be read instead of guessed.
 *
 *   node test/dump-events.mjs <appId> "message" [conversationId]
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SITES, buildTc3Headers } from '../lib/impl.js'

const [appId, message, conversationId] = process.argv.slice(2)
if (appId === undefined || message === undefined) {
  console.log('用法：node test/dump-events.mjs <appId> "消息" [conversationId]')
  process.exit(1)
}

const stored = JSON.parse(
  await readFile(join(process.env.DSH_HOME, 'adp-console', 'state.json'), 'utf8'),
).credentials
const api = SITES.standalone.endpoint
const userId = 'dsh-dump-001'

async function call(action, params) {
  const { headers, body } = buildTc3Headers({
    secretId: stored.secretId, secretKey: stored.secretKey, endpoint: api, service: 'adp',
    action, version: '2026-05-20', region: 'ap-guangzhou', payload: params,
    timestamp: Math.floor(Date.now() / 1000),
  })
  const response = await fetch(`https://${api}/`, { method: 'POST', headers, body })
  const payload = (await response.json()).Response
  if (payload.Error) throw new Error(`${payload.Error.Code}: ${payload.Error.Message}`)
  return payload
}

const appKey = (await call('DescribeApp', { AppId: appId, FieldMask: { Paths: ['SecretInfo'] } }))
  .App.SecretInfo.AppKey
const token = (await call('CreateWebSocketToken', { Type: 5, AppId: appId, AppKey: appKey, UserId: userId })).Token
const conversation = conversationId
  ?? (await call('CreateConversation', { Type: 5, AppId: appId, AppKey: appKey, UserId: userId })).ConversationId

console.log(`appId        : ${appId}`)
console.log(`conversation : ${conversation}`)
console.log('—— 原始帧 ——\n')

const socket = new WebSocket('wss://wss.lke.cloud.tencent.com/adp/v2/chat/conn/?language=zh-CN&EIO=4&transport=websocket')
const seen = new Set()
const counts = new Map()

const finish = () => {
  console.log('\n—— 事件类型统计 ——')
  for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${count.toString().padStart(3)} × ${type}`)
  process.exit(0)
}
// End the dump as soon as the turn completes; a hard cap covers a stalled turn.
setTimeout(finish, 300000)

socket.addEventListener('open', () => console.log('[socket] open'))
socket.addEventListener('close', (event) => { console.log(`[socket] close code=${event.code}`); finish() })
socket.addEventListener('error', () => console.log('[socket] error'))
socket.addEventListener('message', (event) => {
  const frame = typeof event.data === 'string' ? event.data : ''
  if (frame === '') return
  if (frame === '2') { socket.send('3'); return }
  if (frame.startsWith('0')) { console.log(`[engine] ${frame}`); socket.send(`40${JSON.stringify({ token })}`); return }
  if (frame.startsWith('40')) {
    console.log('[socket.io] connected')
    socket.send(`42${JSON.stringify(['request', {
      Type: 'request',
      Request: {
        RequestId: `dump-${Date.now()}`,
        ConversationId: conversation,
        Contents: [{ Type: 'text', Text: message }],
        Incremental: true,
        EnableMultiIntent: true,
        Stream: 'enable',
      },
    }])}`)
    return
  }
  if (!frame.startsWith('42')) { console.log(`[other] ${frame.slice(0, 200)}`); return }
  let parsed
  try { parsed = JSON.parse(frame.slice(2)) } catch { console.log(`[unparsed] ${frame.slice(0, 300)}`); return }
  const payload = Array.isArray(parsed) ? parsed[1] : parsed
  const type = payload?.Type ?? '(none)'
  counts.set(type, (counts.get(type) ?? 0) + 1)
  // Print the first occurrence of each type in full, then only the type name.
  if (!seen.has(type)) {
    seen.add(type)
    console.log(`\n===== 首次出现 ${type} =====`)
    console.log(JSON.stringify(payload, null, 2))
  } else if (type !== 'text.delta' && type !== 'thought.delta') {
    console.log(`  · ${type}`)
  }
  if (type === 'response.completed') setTimeout(finish, 300)
})
