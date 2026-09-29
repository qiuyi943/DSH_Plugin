/**
 * ADP Console self-test.
 *
 * Runs the real Host half against a mock ADP gateway so the whole path — TC3 signing,
 * DescribeAppSummaryList/DescribeApp, the 上架/下架 gate, the browser route, the ADP
 * conversation SSE parser and the agent tools — is exercised without Tencent Cloud
 * credentials or network access.
 *
 *   node test/self-test.mjs
 */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const results = []
/** Record one assertion. */
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
  const mark = condition ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${condition || detail === '' ? '' : `\n      ${detail}`}`)
}

/* ------------------------------------------------------------------ *
 * Mock ADP gateway
 * ------------------------------------------------------------------ */

const APP_RUNNING = '2060000000000000001'
const APP_OFFLINE = '2060000000000000002'
const APP_KEY = 'mock-app-key-0123456789'
/** A SecretId this mock recognises as nonexistent, like a deleted/incorrect key. */
const REJECTED_SECRET_ID = 'AKIDrejected'
/** The conversation id `CreateConversation` hands out. */
const CONVERSATION_ID = 'a235f5d515ac42828c1ca48514007993'
/** Reasoning frames must not reach the answer. */
const THOUGHT_TEXT = '先读取数据……'
/** The actual reply. */
const REPLY_TEXT = '分析结果如下：本季度销售额环比增长 12%。'

let lastAuthorization = ''
let lastAction = ''
let lastVersion = ''
let lastRequestClient = null
let lastPayload = null
let lastConversationRequest = null
/** How many times the turn had to open a conversation, so reuse stays observable. */
let conversationCreateCount = 0

const gateway = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    if (req.url === '/adp/v2/chat') {
      chatResponse(raw, res)
      return
    }
    lastAuthorization = req.headers.authorization ?? ''
    lastAction = req.headers['x-tc-action'] ?? ''
    lastVersion = req.headers['x-tc-version'] ?? ''
    lastRequestClient = req.headers['x-tc-requestclient'] ?? null
    try {
      lastPayload = JSON.parse(raw)
    } catch {
      lastPayload = null
    }
    // The SecretId in the credential scope decides identity, exactly as Tencent Cloud does.
    const caller = /Credential=([^/]+)\//.exec(lastAuthorization)?.[1] ?? ''
    const reply = (body) => {
      const text = JSON.stringify({ Response: { ...body, RequestId: 'mock-request-id' } })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
      res.end(text)
    }
    if (caller === REJECTED_SECRET_ID) {
      reply({ Error: { Code: 'AuthFailure.SecretIdNotFound', Message: 'The SecretId is not found, please ensure that your SecretId is correct.' } })
      return
    }
    switch (lastAction) {
      case 'DescribeRegions':
        reply({ RegionSet: [{ Region: 'ap-guangzhou', RegionName: '华南地区(广州)', RegionState: 'AVAILABLE' }] })
        return
      case 'DescribeSpaceList':
        // The name and the id deliberately differ, which is exactly the trap that
        // produces `4510004-当前空间下没有该用户信息`.
        reply({
          TotalCount: 1,
          SpaceList: [{ SpaceId: 'bfnUUoSh', Name: 'default_space', Description: '-' }],
        })
        return
      case 'DescribeAppSummaryList': {
        const statuses = (lastPayload?.FilterList ?? []).flatMap(filter => filter.ValueList ?? [])
        const wanted = statuses.length === 0 ? [1, 2, 3, 4] : statuses.map(Number)
        const catalogue = [
          {
            AppId: APP_RUNNING, AppMode: 2, Avatar: '', Name: '客服助手',
            Status: { Status: 2, StatusDescription: '运行中' },
            OperationInfo: { Creator: 'tester', UpdateTime: '1780042649' },
          },
          {
            AppId: APP_OFFLINE, AppMode: 1, Avatar: '', Name: '知识问答',
            Status: { Status: 1, StatusDescription: '未上线' },
            OperationInfo: { Creator: 'tester', UpdateTime: '1780042600' },
          },
        ]
        const filtered = catalogue.filter(app => wanted.includes(app.Status.Status))
        reply({ TotalCount: filtered.length, AppSummaryList: filtered })
        return
      }
      case 'DescribeApp':
        reply({ App: { AppId: APP_RUNNING, SecretInfo: { AppKey: APP_KEY, CreateTime: '1780042649' } } })
        return
      case 'CreateConversation':
        // The documented prerequisite: Type=5 (API 接入) and the app's own AppKey.
        lastConversationRequest = lastPayload
        conversationCreateCount += 1
        if (lastPayload?.AppKey !== APP_KEY) {
          reply({ Error: { Code: 'FailedOperation', Message: '400-请求参数错误, 请参阅接入文档.' } })
          return
        }
        reply({ ConversationId: CONVERSATION_ID })
        return
      case 'CreateRelease':
        reply({ ReleaseId: 'rel-1', NeedApproval: false })
        return
      case 'DescribeLatestRelease':
        reply({
          IsChanged: false,
          ReleaseSummary: {
            ReleaseId: 'rel-1', Status: 3, StatusDescription: '发布成功',
            CreateTime: '1780042649', Description: 'self-test', ChannelIdList: [],
          },
        })
        return
      default:
        reply({ Error: { Code: 'InvalidAction', Message: `unknown action ${lastAction}` } })
    }
  })
})

/**
 * Emit the documented SSE frame sequence for one chat turn.
 *
 * Shapes taken from a live capture on the 独立站: `message.added` nests the kind in
 * `Message.Type` (`thought` / `reply`) and repeats the id; `text.delta` carries a flat
 * `Text`. The event name rides the payload's `Type`, with `data:`-only lines.
 */
function chatResponse(rawBody, res) {
  let body = null
  try {
    body = JSON.parse(rawBody)
  } catch {
    body = null
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
  const frame = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  frame({ Type: 'request_ack', RequestId: body?.RequestId })
  frame({ Type: 'response.created', RecordId: 'r1' })
  // A Claw agent narrates each step as its own reply; two of them must not be glued.
  if (body?.Contents?.[0]?.Text === 'MULTI') {
    frame({ Type: 'message.added', MessageId: 's1', Message: { Type: 'reply', MessageId: 's1', Contents: [{ Type: 'text' }] } })
    frame({ Type: 'text.delta', MessageId: 's1', Text: '第一批资料已获取。' })
    frame({ Type: 'message.added', MessageId: 's2', Message: { Type: 'reply', MessageId: 's2', Contents: [{ Type: 'text' }] } })
    frame({ Type: 'text.delta', MessageId: 's2', Text: '继续搜索验证关键数据。' })
    frame({
      Type: 'response.completed',
      Response: {
        RecordId: 'r1',
        Messages: [
          { Type: 'reply', MessageId: 's1', Contents: [{ Type: 'text', Text: '第一批资料已获取。' }] },
          { Type: 'reply', MessageId: 's2', Contents: [{ Type: 'text', Text: '继续搜索验证关键数据。' }] },
        ],
      },
    })
    res.write('event: done\ndata: [DONE]\n\n')
    res.end()
    globalThis.__lastChatBody = body
    return
  }
  frame({ Type: 'message.added', MessageId: 'm1', Message: { Type: 'thought', MessageId: 'm1', Contents: [{ Type: 'text' }] } })
  frame({ Type: 'text.delta', MessageId: 'm1', Text: THOUGHT_TEXT })
  frame({ Type: 'message.done', MessageId: 'm1' })
  frame({ Type: 'message.added', MessageId: 'm2', Message: { Type: 'reply', MessageId: 'm2', Contents: [{ Type: 'text' }] } })
  frame({ Type: 'text.delta', MessageId: 'm2', Text: REPLY_TEXT.slice(0, 6) })
  frame({ Type: 'text.delta', MessageId: 'm2', Text: REPLY_TEXT.slice(6) })
  // The completed frame restates every message; this is where a human-in-the-loop
  // `questionnaire` content arrives. Shape taken verbatim from a live capture.
  frame({
    Type: 'response.completed',
    Response: {
      RecordId: 'r1',
      Messages: [
        { Type: 'reply', MessageId: 'm2', Contents: [{ Type: 'text', Text: REPLY_TEXT }] },
        {
          Type: 'reply',
          MessageId: 'q1',
          Contents: [{
            Type: 'questionnaire',
            Questionnaire: {
              Title: '插图方式',
              Questions: [{
                Index: 0,
                Question: 'PPT 中的插图希望采用哪种方式？',
                Type: 1,
                Required: false,
                Options: [
                  { Label: 'AI 生成插图（推荐）', Description: '为关键章节调用图像生成模型。' },
                  { Label: '无插图', Description: '纯文字排版。' },
                ],
              }],
            },
          }],
        },
      ],
    },
  })
  res.write('event: done\ndata: [DONE]\n\n')
  res.end()
  // Echo the request so the test can assert the wire body shape.
  globalThis.__lastChatBody = body
}

/* ------------------------------------------------------------------ *
 * Fake Cordis context
 * ------------------------------------------------------------------ */

/**
 * Build one isolated fake Host context: its own tool table and route table.
 *
 * `webServer: false` models a cold start, where the HTTP carrier is not mounted yet.
 * `provideWebServer()` then mounts it, which must still bring the route up — the bug
 * that left the panel talking to a 404 after a restart.
 */
function createHarness({ webServer = true } = {}) {
  const tools = new Map()
  const routes = []
  const waiting = []
  const listeners = new Map()
  const webCtx = {
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  let mounted = webServer
  const ctx = {
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get() {
      return undefined
    },
    // Cordis runs the callback immediately when the service already exists, and defers
    // it otherwise. Both paths are modelled so the cold-start case is testable.
    inject(dependencies, callback) {
      if (mounted && dependencies.includes('webServer')) callback(webCtx)
      else waiting.push({ dependencies, callback })
    },
    /**
     * The plugin-owned Event registrations. `agent/pre-step` and `llm/stream` are
     * waterfalls, so the harness has to dispatch them like Cordis: registration order,
     * each listener owning the decision and calling `next()` to reach the next one.
     */
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    async emit() {},
  }

  /** Mount the HTTP carrier, running whatever was waiting for it. */
  function provideWebServer() {
    mounted = true
    for (const entry of waiting.splice(0)) {
      if (entry.dependencies.includes('webServer')) entry.callback(webCtx)
    }
  }
  if (webServer) provideWebServer()

  /** Drive one route of this harness and return the parsed response. */
  async function call(method, path, body) {
    const route = routes[0]
    const res = fakeResponse()
    await route.handler(fakeRequest(method, `/adp-console${path}`, body), res)
    const text = res.body ?? res.chunks.join('')
    if ((res.headers['Content-Type'] ?? '').includes('text/event-stream')) return { raw: text, status: res.statusCode }
    return { json: JSON.parse(text), status: res.statusCode }
  }

  /** Run one waterfall; `inner` is what the innermost `next()` resolves to. */
  function waterfall(name, payload, inner) {
    const list = listeners.get(name) ?? []
    const run = index => (index >= list.length ? inner() : list[index](payload, () => run(index + 1)))
    return run(0)
  }

  /** Dispatch one emit-mode Event. */
  function emitEvent(name, ...args) {
    for (const handler of listeners.get(name) ?? []) handler(...args)
  }

  return { ctx, tools, routes, call, provideWebServer, waterfall, emitEvent, listeners }
}

/** Minimal `IncomingMessage`. */
function fakeRequest(method, url, body) {
  const payload = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    on() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

/** Minimal `ServerResponse`. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    chunks: [],
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = { ...this.headers, ...headers }
      this.headersSent = true
    },
    write(chunk) {
      this.headersSent = true
      this.chunks.push(chunk)
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(chunk)
      this.body = this.chunks.join('')
      this.headersSent = true
    },
    on() {},
  }
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const port = await new Promise((resolve) => {
  gateway.listen(0, '127.0.0.1', () => resolve(gateway.address().port))
})
const origin = `127.0.0.1:${port}`

const mod = await import(pathToFileURL(join(here, '..', 'lib', 'impl.js')).href)

/** The harness the main scenarios run against. */
const primary = createHarness()
const tools = primary.tools
const routes = primary.routes
const callRoute = primary.call
const ctx = primary.ctx

/* --- 1. TC3 signature against Tencent Cloud's published vector --- */
// https://cloud.tencent.com/document/api/1759/132550 (签名方法 v3) worked example.
// Its payload serialisation keeps the spaces and the \u escapes the doc prints.
const vectorPayload = '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}'
const vector = mod.buildTc3Headers({
  secretId: 'AKID********************************',
  secretKey: '********************************',
  endpoint: 'cvm.tencentcloudapi.com',
  service: 'cvm',
  action: 'DescribeInstances',
  version: '2017-03-12',
  region: 'ap-guangzhou',
  timestamp: 1551113065,
  body: vectorPayload,
})
const expectedSignature = '10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f'
const actualSignature = /Signature=([0-9a-f]+)/.exec(vector.headers.Authorization)?.[1]
check(
  'TC3-HMAC-SHA256 matches Tencent Cloud’s published cvm vector',
  actualSignature === expectedSignature,
  `expected ${expectedSignature}\n      actual   ${actualSignature}`,
)
check(
  'TC3 credential scope names the product service and its UTC date',
  vector.headers.Authorization.includes('Credential=AKID********************************/2019-02-25/cvm/tc3_request'),
  vector.headers.Authorization,
)
check(
  'TC3 signs content-type;host;x-tc-action in ASCII order',
  vector.headers.Authorization.includes('SignedHeaders=content-type;host;x-tc-action'),
  vector.headers.Authorization,
)

/* --- 2. Plugin activation --- */
const stateDir = await mkdtemp(join(tmpdir(), 'adp-console-'))
const statePath = join(stateDir, 'state.json')
mod.apply(ctx, {
  secretId: 'AKIDtest000000000000',
  secretKey: 'SECRETtest000000000000',
  region: 'ap-guangzhou',
  spaceId: 'default_space',
  endpoint: origin,
  protocol: 'http',
  apiVersion: '2026-05-20',
  chatEndpoint: `http://${origin}/adp/v2/chat`,
  routePrefix: '/adp-console',
  statePath,
  defaultEnabledAppIds: [],
  requestTimeoutMs: 10000,
  releaseTimeoutMs: 10000,
  appKeyCacheMs: 300000,
  exposeTools: true,
})

check('registers the five agent tools', tools.size === 5, [...tools.keys()].join(', '))
check(
  'tool names are the documented ones',
  ['adp_list_apps', 'adp_list_spaces', 'adp_set_app_enabled', 'adp_publish_app', 'adp_chat'].every(name => tools.has(name)),
)
check('registers exactly one browser route at the configured prefix', routes.length === 1 && routes[0].path === '/adp-console')
check('route is a prefix route', routes[0].kind === 'prefix')

/* --- 3. Catalogue + gate through the browser route --- */
const config = await callRoute('GET', '/config')
check('GET /config reports configured credentials', config.json.configured === true, JSON.stringify(config.json))
check('GET /config masks the SecretId', config.json.secretIdHint === 'AKID****0000', config.json.secretIdHint)
check('GET /config names the credential source', config.json.source === 'config', config.json.source)

const listed = await callRoute('GET', '/apps?status=running')
check('GET /apps returns the running app', listed.json.apps.length === 1 && listed.json.apps[0].appId === APP_RUNNING)
check('new apps start disabled (下架)', listed.json.apps[0].dshEnabled === false)
check('the request carried signed ADP headers', lastAuthorization.startsWith('TC3-HMAC-SHA256 Credential=AKIDtest000000000000/'), lastAuthorization)
check(
  'DescribeAppSummaryList was filtered to running and scoped to the space',
  lastPayload?.SpaceId === 'default_space'
    && JSON.stringify(lastPayload?.FilterList) === JSON.stringify([{ Name: 'AppStatus', ValueList: ['2'] }]),
  JSON.stringify(lastPayload),
)

const enabled = await callRoute('POST', '/enabled', JSON.stringify({ appId: APP_RUNNING, enabled: true }))
check('POST /enabled turns the gate on', enabled.json.dshEnabled === true, JSON.stringify(enabled.json))
const persisted = JSON.parse(await readFile(statePath, 'utf8'))
check('the gate is persisted to disk', JSON.stringify(persisted.enabledAppIds) === JSON.stringify([APP_RUNNING]), await readFile(statePath, 'utf8'))

const relisted = await callRoute('GET', '/apps?status=running')
check('the enabled flag survives a catalogue reload', relisted.json.apps[0].dshEnabled === true)

/* --- 4. Conversation SSE through the browser route --- */
const chat = await callRoute('POST', '/chat', JSON.stringify({ appId: APP_RUNNING, message: '你好' }))
check('POST /chat answers with an event stream', typeof chat.raw === 'string' && chat.raw.includes('event: console.delta'))
check(
  'the answer is the reply message, with the reasoning frames excluded',
  // The reasoning text legitimately rides the raw `adp.event` trace; what must not
  // contain it is the user-visible answer channel.
  (() => {
    const deltas = [...chat.raw.matchAll(/event: console\.delta\ndata: (\{[^\n]*\})/g)]
      .map(match => JSON.parse(match[1]).text)
      .join('')
    const done = /event: console\.done\ndata: (\{[^\n]*\})/.exec(chat.raw)
    return deltas === REPLY_TEXT && done !== null && JSON.parse(done[1]).text === REPLY_TEXT
  })(),
  `deltas/done = ${[...chat.raw.matchAll(/event: console\.(?:delta|done)\ndata: (\{[^\n]*\})/g)].map(m => JSON.parse(m[1]).text).join(' | ').slice(0, 200)}`,
)
check(
  'the chat opens its conversation through CreateConversation(Type=5, AppKey)',
  lastConversationRequest?.Type === 5
    && lastConversationRequest.AppKey === APP_KEY
    && lastConversationRequest.AppId === APP_RUNNING
    && typeof lastConversationRequest.UserId === 'string',
  JSON.stringify(lastConversationRequest),
)
check(
  'the chat reuses the conversation id the management API returned',
  globalThis.__lastChatBody?.ConversationId === CONVERSATION_ID,
  String(globalThis.__lastChatBody?.ConversationId),
)
check(
  'deltas stream through as they arrive',
  (chat.raw.match(/event: console\.delta/g) ?? []).length === 2,
  `${(chat.raw.match(/event: console\.delta/g) ?? []).length} deltas`,
)
check('adp events are forwarded to the panel', chat.raw.includes('event: adp.event'))
check(
  'console.done carries the authoritative full reply',
  chat.raw.includes(`"text":"${REPLY_TEXT}"`),
  chat.raw.split('\n').filter(line => line.startsWith('event: console.done')).join('|'),
)
check(
  'the reply is not double counted (done replaces deltas, never appends)',
  !chat.raw.includes('你好！我是 ADP 智能体，很高兴为你服务。你好！我是 ADP 智能体'),
)
check(
  'the chat request identifies the end user under both documented field names',
  // The cloud doc requires `UserId`; the 独立站 doc uses `VisitorId`. Sending both
  // keeps one code path correct on either site.
  typeof globalThis.__lastChatBody?.VisitorId === 'string'
    && globalThis.__lastChatBody.VisitorId !== ''
    && globalThis.__lastChatBody.UserId === globalThis.__lastChatBody.VisitorId,
  JSON.stringify(globalThis.__lastChatBody),
)
check(
  'the chat request used the documented Contents shape',
  Array.isArray(globalThis.__lastChatBody?.Contents)
    && globalThis.__lastChatBody.Contents[0].Type === 'text'
    && globalThis.__lastChatBody.Contents[0].Text === '你好'
    && globalThis.__lastChatBody.Stream === 'enable'
    && /^[a-zA-Z0-9_-]{32,64}$/.test(globalThis.__lastChatBody.ConversationId ?? '')
    && globalThis.__lastChatBody.AppKey === APP_KEY,
  JSON.stringify(globalThis.__lastChatBody),
)

/* --- 5. The gate blocks a disabled app --- */
const blocked = await callRoute('POST', '/chat', JSON.stringify({ appId: APP_OFFLINE, message: '你好' }))
check(
  'POST /chat refuses a disabled app before opening a stream',
  blocked.json?.ok === false && String(blocked.json.error).includes('未上架'),
  JSON.stringify(blocked.json),
)

let toolBlocked = false
try {
  await tools.get('adp_chat').execute({ appId: APP_OFFLINE, message: '你好' }, { signal: undefined, agent: { id: 'session-1' } })
} catch (error) {
  toolBlocked = error?.code === 'AppNotEnabled'
}
check('the adp_chat tool refuses a disabled app', toolBlocked)

/* --- 6. Agent tools --- */
const toolList = await tools.get('adp_list_apps').execute({ status: 'all' }, { signal: undefined, agent: { id: 'session-1' } })
check('adp_list_apps returns both apps for status=all', toolList.apps.length === 2, JSON.stringify(toolList).slice(0, 200))
check('adp_list_apps marks the gate on each row', toolList.apps.find(a => a.appId === APP_RUNNING)?.dshEnabled === true)
check(
  'adp_list_apps renders text the model can read',
  tools.get('adp_list_apps').output.render({}, toolList)[0].text.includes('上架'),
)

const gateWrite = await tools.get('adp_set_app_enabled').execute(
  { appId: APP_OFFLINE, enabled: true },
  { signal: undefined, agent: { id: 'session-1' } },
)
check('adp_set_app_enabled publishes the new gate', gateWrite.dshEnabled === true && gateWrite.enabledAppIds.includes(APP_OFFLINE))

const toolChat = await tools.get('adp_chat').execute(
  { appId: APP_OFFLINE, message: '你好' },
  { signal: undefined, agent: { id: 'session-1' } },
)
check('adp_chat returns the aggregated reply', toolChat.reply === REPLY_TEXT, JSON.stringify(toolChat).slice(0, 200))
check(
  'adp_chat renders the reply as text content',
  tools.get('adp_chat').output.render({}, toolChat)[0].type === 'text',
)

const release = await tools.get('adp_publish_app').execute(
  { appId: APP_OFFLINE },
  { signal: undefined, agent: { id: 'session-1' } },
)
check('adp_publish_app polls the release to success', release.status === 'success' && release.succeeded === true, JSON.stringify(release))

/* --- 7. Credentials entered in the panel, and the clean refusal without them --- */
const secondary = createHarness()
const secondaryStatePath = join(stateDir, 'state-2.json')
mod.apply(secondary.ctx, {
  secretId: '', secretKey: '', region: 'ap-guangzhou', spaceId: 'default_space',
  endpoint: origin, protocol: 'http', apiVersion: '2026-05-20', chatEndpoint: `http://${origin}/adp/v2/chat`,
  routePrefix: '/adp-console', statePath: secondaryStatePath, defaultEnabledAppIds: [],
  requestTimeoutMs: 10000, releaseTimeoutMs: 5000, appKeyCacheMs: 1000, exposeTools: true,
})

const blank = await secondary.call('GET', '/config')
check('GET /config reports no credentials', blank.json.configured === false && blank.json.source === 'none', JSON.stringify(blank.json))

const refused = await secondary.call('GET', '/apps?status=running')
check(
  'the catalogue refuses cleanly without credentials',
  refused.json.ok === false && refused.json.code === 'MissingCredentials',
  JSON.stringify(refused.json).slice(0, 200),
)

const halfSaved = await secondary.call('POST', '/config', JSON.stringify({ secretId: 'AKIDonly' }))
check('saving only a SecretId is refused', halfSaved.json.ok === false && String(halfSaved.json.error).includes('同时'), JSON.stringify(halfSaved.json))

const saved = await secondary.call('POST', '/config', JSON.stringify({
  secretId: 'AKIDpanel0000000000',
  secretKey: 'SECRETpanel0000000000',
  region: 'ap-guangzhou',
  spaceId: 'space-from-panel',
}))
check('POST /config stores the key pair', saved.json.configured === true && saved.json.source === 'panel', JSON.stringify(saved.json))
check('POST /config never echoes the SecretKey', !JSON.stringify(saved.json).includes('SECRETpanel'), JSON.stringify(saved.json))

const persistedState = JSON.parse(await readFile(secondaryStatePath, 'utf8'))
check(
  'the credentials are persisted for the next boot',
  persistedState.credentials?.secretId === 'AKIDpanel0000000000'
    && persistedState.credentials?.secretKey === 'SECRETpanel0000000000'
    && persistedState.credentials?.spaceId === 'space-from-panel',
  JSON.stringify(persistedState).slice(0, 200),
)
const stateMode = (await stat(secondaryStatePath)).mode & 0o777
check('the credential file is owner-only (0600)', stateMode === 0o600, `mode ${stateMode.toString(8)}`)

const afterSave = await secondary.call('GET', '/apps?status=running')
check('the catalogue works with panel credentials', afterSave.json.ok === true && afterSave.json.apps.length === 1, JSON.stringify(afterSave.json).slice(0, 200))
check(
  'the panel-chosen space reaches ADP',
  lastPayload?.SpaceId === 'space-from-panel',
  JSON.stringify(lastPayload),
)

const cleared = await secondary.call('POST', '/config', JSON.stringify({ clear: true }))
check('POST /config can clear the credentials', cleared.json.configured === false, JSON.stringify(cleared.json))

/* --- 8. Credential verification and auth diagnostics --- */
const verifyBase = {
  secretId: 'AKIDverify', secretKey: 'SECRETverify', protocol: 'http',
  region: 'ap-guangzhou', spaceId: 'default_space', apiVersion: '2026-05-20',
}
const probe = (id, site, action = 'DescribeAppSummaryList') => ({
  id, site, label: id, endpoint: origin, service: 'adp',
  action, apiVersion: '2026-05-20', params: { SpaceId: 'default_space' },
})
const goodPlan = [
  { ...probe('identity', 'cn', 'DescribeRegions'), service: 'cvm' },
  probe('cn', 'cn'),
  probe('intl', 'intl'),
  probe('standalone', 'standalone'),
]

const good = await mod.verifyCredentials({ ...verifyBase, site: 'cn', endpoint: origin }, undefined, goodPlan)
check('verifyCredentials reports a healthy key pair', good.verdict === 'ok' && good.checks.every(c => c.ok), JSON.stringify(good).slice(0, 200))

// A key Tencent Cloud rejects everywhere: every probe fails, so the key is the problem.
const bad = await mod.verifyCredentials(
  { ...verifyBase, secretId: REJECTED_SECRET_ID, site: 'cn', endpoint: origin },
  undefined,
  goodPlan,
)
check(
  'an unknown key is attributed to the key, not to ADP',
  bad.verdict === 'bad-key'
    && bad.checks.every(c => !c.ok)
    && bad.checks[0].code === 'AuthFailure.SecretIdNotFound'
    && bad.checks[0].message.includes('cam/capi'),
  JSON.stringify(bad).slice(0, 300),
)

// The key works only on another site: the current site fails, that site succeeds.
const wrongSite = await mod.verifyCredentials(
  { ...verifyBase, site: 'cn', endpoint: origin },
  undefined,
  goodPlan.map(step => (step.id === 'cn' ? { ...step, action: 'RejectMe' } : step)),
)
check('a key that only works elsewhere reports the wrong site', wrongSite.verdict === 'wrong-site', JSON.stringify(wrongSite).slice(0, 240))

// 独立站 has no Tencent Cloud identity probe: a standalone key that works must pass
// on the standalone endpoint alone, and a key from another site must be reported.
const standalonePlan = [
  probe('standalone', 'standalone'),
  probe('cn', 'cn'),
  probe('intl', 'intl'),
]
const standaloneOk = await mod.verifyCredentials(
  { ...verifyBase, site: 'standalone', endpoint: origin },
  undefined,
  standalonePlan,
)
check('a 独立站 key passes without a Tencent Cloud identity probe', standaloneOk.verdict === 'ok', JSON.stringify(standaloneOk).slice(0, 240))

const standaloneWrong = await mod.verifyCredentials(
  { ...verifyBase, site: 'standalone', endpoint: origin },
  undefined,
  standalonePlan.map(step => (step.id === 'standalone' ? { ...step, action: 'RejectMe' } : step)),
)
check(
  'a cloud key used on 独立站 is reported as the wrong site',
  standaloneWrong.verdict === 'wrong-site' && standaloneWrong.site === 'standalone',
  JSON.stringify(standaloneWrong).slice(0, 240),
)

check(
  'every probe sends X-TC-Version (a missing one makes the API reject the action)',
  standaloneOk.checks.every(check => check.ok) && good.checks.every(check => check.ok) && lastVersion === '2026-05-20',
  `last X-TC-Version = ${JSON.stringify(lastVersion)}`,
)
check(
  'the standalone site’s own error vocabulary is explained',
  mod.describeApiError('ADP X 调用失败', {
    Code: 'FailedOperation',
    Message: '450203-ErrSecretNotFound',
  }).includes('adp.tencent.com/adp#/key-manage'),
)
check(
  'the SecretIdNotFound message points at key management, not at ADP',
  mod.describeApiError('ADP X 调用失败', {
    Code: 'AuthFailure.SecretIdNotFound',
    Message: 'The SecretId is not found, please ensure that your SecretId is correct.',
  }).includes('console.cloud.tencent.com/cam/capi'),
)
check(
  'an unmapped error code passes through unchanged',
  mod.describeApiError('ADP X 调用失败', { Code: 'InvalidAction', Message: 'nope' }) === 'ADP X 调用失败: InvalidAction — nope',
)
// Site → endpoint derivation needs a harness with no explicit `endpoint` override,
// because an explicit host deliberately wins over the site table.
const siteHarness = createHarness()
mod.apply(siteHarness.ctx, {
  secretId: 'AKIDsite', secretKey: 'SECRETsite', region: 'ap-guangzhou', spaceId: 'default_space',
  site: 'cn', endpoint: '', chatEndpoint: '', protocol: 'http', apiVersion: '2026-05-20',
  routePrefix: '/adp-console', statePath: join(stateDir, 'state-3.json'), defaultEnabledAppIds: [],
  requestTimeoutMs: 10000, releaseTimeoutMs: 5000, appKeyCacheMs: 1000, exposeTools: false,
})

const cnView = (await siteHarness.call('GET', '/config')).json
check(
  'the default site is 腾讯云 with the CAM key source',
  cnView.endpoint === 'adp.tencentcloudapi.com' && cnView.keySource === '腾讯云 CAM 控制台',
  JSON.stringify(cnView),
)
check(
  'the panel can switch the deployment site',
  (await siteHarness.call('POST', '/config', JSON.stringify({ site: 'intl' }))).json.endpoint === 'adp.intl.tencentcloudapi.com',
)
check(
  'the switch also moves the conversation endpoint',
  (await siteHarness.call('GET', '/config')).json.chatEndpoint === 'https://wss.lke.tencentcloud.com/adp/v2/chat',
)
const standaloneView = (await siteHarness.call('POST', '/config', JSON.stringify({ site: 'standalone' }))).json
check(
  'the 独立站 site resolves to its own request domain and key source',
  standaloneView.endpoint === 'capi.adp.tencent.com'
    && standaloneView.site === 'standalone'
    && standaloneView.keySource === 'ADP 控制台 > 密钥管理',
  JSON.stringify(standaloneView),
)
check(
  'the 独立站 conversation stream uses its own host, not the cloud one',
  standaloneView.chatEndpoint === 'https://adp.tencent.com/adp/v2/chat',
  standaloneView.chatEndpoint,
)
// A standing `endpoint` in the config must not defeat a later panel site choice,
// because the pre-restart generation reads only that config value.
const pinned = createHarness()
mod.apply(pinned.ctx, {
  secretId: 'AKIDpinned', secretKey: 'SECRETpinned', region: 'ap-guangzhou', spaceId: 'default_space',
  site: 'standalone', endpoint: 'capi.adp.tencent.com', chatEndpoint: '', protocol: 'http',
  apiVersion: '2026-05-20', routePrefix: '/adp-console', statePath: join(stateDir, 'state-4.json'),
  defaultEnabledAppIds: [], requestTimeoutMs: 10000, releaseTimeoutMs: 5000, appKeyCacheMs: 1000, exposeTools: false,
})
check(
  'a standing endpoint config still serves the standalone default',
  (await pinned.call('GET', '/config')).json.endpoint === 'capi.adp.tencent.com',
)
check(
  'a panel site choice overrides the standing endpoint config',
  (await pinned.call('POST', '/config', JSON.stringify({ site: 'cn' }))).json.endpoint === 'adp.tencentcloudapi.com',
)
check(
  'the 独立站 choice is persisted for the next boot',
  JSON.parse(await readFile(join(stateDir, 'state-3.json'), 'utf8')).credentials.site === 'standalone',
  await readFile(join(stateDir, 'state-3.json'), 'utf8'),
)
check(
  'an unknown site is refused',
  (await siteHarness.call('POST', '/config', JSON.stringify({ site: 'nope' }))).json.ok === false,
)

/* --- 9. Space discovery, and the name-vs-id trap --- */
const spaceList = await tools.get('adp_list_spaces').execute({}, { signal: undefined, agent: { id: 'session-1' } })
check(
  'adp_list_spaces reports the real SpaceId, not the space name',
  spaceList.spaces.length === 1
    && spaceList.spaces[0].spaceId === 'bfnUUoSh'
    && spaceList.spaces[0].name === 'default_space',
  JSON.stringify(spaceList),
)
check(
  'adp_list_spaces marks the configured space',
  tools.get('adp_list_spaces').output.render({}, { ...spaceList, currentSpaceId: 'bfnUUoSh' })[0].text.includes('← 当前'),
)

const spacesRoute = await callRoute('GET', '/spaces')
check(
  'GET /spaces exposes the same list to the panel',
  spacesRoute.json.ok === true && spacesRoute.json.spaces[0].spaceId === 'bfnUUoSh',
  JSON.stringify(spacesRoute.json).slice(0, 200),
)
check(
  'the space-name error explains the name-vs-id trap',
  mod.describeApiError('ADP DescribeAppSummaryList 调用失败', {
    Code: 'FailedOperation',
    Message: '4510004-当前空间下没有该用户信息',
  }).includes('adp_list_spaces'),
)
check(
  'the unresolved-bot error points at the console publish step and the repro',
  (() => {
    const text = mod.describeApiError('ADP 会话接口', { Code: '460004', Message: '机器人不存在' })
    return text.includes('控制台') && text.includes('发布') && text.includes('460048')
  })(),
  mod.describeApiError('ADP 会话接口', { Code: '460004', Message: '机器人不存在' }),
)
check(
  'an unpublished app is told to publish first',
  mod.describeApiError('ADP 会话接口', { Code: '460048', Message: '应用未发布' }).includes('先发布'),
)
check(
  'the standalone secret error still points at the standalone key page',
  mod.describeApiError('ADP X 调用失败', {
    Code: 'FailedOperation',
    Message: '450203-ErrSecretNotFound',
  }).includes('adp.tencent.com/adp#/key-manage'),
)

/* --- 10. Conversation transport selection --- */
const transportOptions = { endpoint: origin, wsEndpoint: 'wss://example.invalid/ws', appKey: APP_KEY }
const sseResult = { text: 'from sse', conversationId: 'c-sse', transport: 'sse' }
const wsResult = { text: 'from ws', conversationId: 'c-ws', transport: 'ws' }
const unresolved = new mod.AdpError('ADP 会话接口: 460004 — 机器人不存在', { code: 'ChatEventError' })
const unpublished = new mod.AdpError('ADP 会话接口: 460048 — 应用未发布', { code: 'ChatEventError' })
const network = new mod.AdpError('无法连接', { code: 'NetworkFailure' })

check(
  'auto keeps the SSE result when SSE works',
  (await mod.runAdpChat({ ...transportOptions, transport: 'auto', sse: async () => sseResult, ws: async () => wsResult })).transport === 'sse',
)
check(
  'auto falls back to the WS channel when SSE cannot resolve the app',
  (await mod.runAdpChat({
    ...transportOptions,
    transport: 'auto',
    sse: async () => { throw unresolved },
    ws: async () => wsResult,
  })).transport === 'ws',
)
check(
  'auto does not fall back for a merely unpublished app',
  await (async () => {
    try {
      await mod.runAdpChat({ ...transportOptions, transport: 'auto', sse: async () => { throw unpublished }, ws: async () => wsResult })
      return false
    } catch (error) {
      return error === unpublished
    }
  })(),
)
check(
  'auto does not fall back for a transport failure',
  await (async () => {
    try {
      await mod.runAdpChat({ ...transportOptions, transport: 'auto', sse: async () => { throw network }, ws: async () => wsResult })
      return false
    } catch (error) {
      return error === network
    }
  })(),
)
check(
  'transport=ws skips SSE entirely',
  (await mod.runAdpChat({
    ...transportOptions,
    transport: 'ws',
    sse: async () => { throw new Error('SSE must not run') },
    ws: async () => wsResult,
  })).transport === 'ws',
)
check(
  'the 独立站 WS channel has its own documented host',
  mod.SITES.standalone.wsEndpoint === 'wss://wss.lke.cloud.tencent.com/adp/v2/chat/conn/',
  mod.SITES.standalone.wsEndpoint,
)

/* --- 11. Cold start: the route must survive a late webServer --- */
const coldHarness = createHarness({ webServer: false })
mod.apply(coldHarness.ctx, {
  secretId: 'AKIDcold', secretKey: 'SECRETcold', region: 'ap-guangzhou', spaceId: 'default_space',
  site: 'standalone', endpoint: '', chatEndpoint: '', wsEndpoint: '', protocol: 'http',
  apiVersion: '2026-05-20', routePrefix: '/adp-console', statePath: join(stateDir, 'state-5.json'),
  defaultEnabledAppIds: [], requestTimeoutMs: 10000, releaseTimeoutMs: 5000, appKeyCacheMs: 1000,
  exposeTools: false, chatTransport: 'auto',
})
check('no route is registered before the HTTP carrier exists', coldHarness.routes.length === 0)
coldHarness.provideWebServer()
check(
  'the route appears once webServer mounts (cold-start race)',
  coldHarness.routes.length === 1 && coldHarness.routes[0].path === '/adp-console',
  `${coldHarness.routes.length} route(s)`,
)
check(
  'the late-registered route actually answers',
  (await coldHarness.call('GET', '/config')).json.ok === true,
)

/* --- 12. Panel styling: theme tokens only, no literal foreground colours --- */
// A hardcoded `#fff` on `brand-primary` is invisible in dark mode, because the theme
// inverts that token (light theme near-black, dark theme near-white). Text on a brand
// fill must use the paired foreground token the host itself uses.
// The stylesheet is a JS array whose entries are one string per CSS fragment, so a
// single rule can span several entries; join every pure string-literal line.
const panelCss = (await readFile(join(here, '..', 'client.js'), 'utf8'))
  .split('\n')
  .filter(line => /^\s*'/.test(line))
  .join('')

check(
  'the panel CSS uses no literal colour values',
  !/(?:^|[^-])(?:color|background|border-color)\s*:\s*(?:#|rgba?\(|hsla?\()/i.test(panelCss),
  (panelCss.match(/(?:color|background|border-color)\s*:\s*(?:#|rgba?\()[^;}]*/gi) ?? []).join(' | ').slice(0, 200),
)
// Rule-scoped rather than element-scoped: any declaration block that paints a brand
// fill must pair it with the theme's foreground token, whatever the selector is.
// Only rules that paint BOTH a brand fill and a text colour need the pairing: a switch
// track carries no text (its foreground is the `.adp-knob`, asserted below), exactly as
// the Host's own `.switch` / `.thumb` pair does.
const brandFillTextRules = panelCss
  .split('}')
  .filter(rule => /background:[^;]*(?:brand-primary|button-primary-fill)/.test(rule))
  .filter(rule => /[^-]color:/.test(rule))
check(
  'text on a brand fill uses the paired foreground token',
  brandFillTextRules.length > 0
    && brandFillTextRules.every(rule => rule.includes('label-primary-foreground')),
  brandFillTextRules.filter(rule => !rule.includes('label-primary-foreground')).join(' | ').slice(0, 200),
)
check(
  'the switch knob uses the theme foreground token',
  panelCss.includes('.adp-knob{') && panelCss.includes('background:var(--dsw-alias-label-primary-foreground)'),
)
check(
  'the toggle mirrors the host switch tokens',
  panelCss.includes('.adp-switch{') && panelCss.includes('--dsw-alias-border-l3'),
)

/* --- 13. Official SDK transport, with the built-in signer as fallback --- */
// The SDK adds an `X-TC-RequestClient` header the plugin's own signer never sends, so
// the mock can tell the two transports apart.
check(
  'the manifest declares the official ADP SDK',
  /"tencentcloud-sdk-nodejs-adp"/.test(await readFile(join(here, '..', 'package.json'), 'utf8')),
)

const sdkHarness = createHarness()
mod.apply(sdkHarness.ctx, {
  secretId: 'AKIDsdk', secretKey: 'SECRETsdk', region: 'ap-guangzhou', spaceId: 'default_space',
  site: 'standalone', endpoint: origin, chatEndpoint: '', wsEndpoint: '', protocol: 'http',
  apiVersion: '2026-05-20', routePrefix: '/adp-console', statePath: join(stateDir, 'state-sdk.json'),
  defaultEnabledAppIds: [], requestTimeoutMs: 10000, releaseTimeoutMs: 5000, appKeyCacheMs: 1000,
  exposeTools: false, chatTransport: 'auto', useSdk: true,
})
const sdkListed = await sdkHarness.call('GET', '/apps?status=running')
const viaSdk = lastRequestClient
const sdkInstalled = existsSync(join(here, '..', 'node_modules', 'tencentcloud-sdk-nodejs-adp'))
check(
  'ADP calls go through the official SDK when it is installed',
  !sdkInstalled || viaSdk !== null,
  `installed=${sdkInstalled} · X-TC-RequestClient=${JSON.stringify(viaSdk)}`,
)
check('the SDK path returns the same catalogue', sdkListed.json.ok === true && sdkListed.json.apps[0].appId === APP_RUNNING)

const httpHarness = createHarness()
mod.apply(httpHarness.ctx, {
  secretId: 'AKIDhttp', secretKey: 'SECRETh', region: 'ap-guangzhou', spaceId: 'default_space',
  site: 'standalone', endpoint: origin, chatEndpoint: '', wsEndpoint: '', protocol: 'http',
  apiVersion: '2026-05-20', routePrefix: '/adp-console', statePath: join(stateDir, 'state-http.json'),
  defaultEnabledAppIds: [], requestTimeoutMs: 10000, releaseTimeoutMs: 5000, appKeyCacheMs: 1000,
  exposeTools: false, chatTransport: 'auto', useSdk: false,
})
const httpListed = await httpHarness.call('GET', '/apps?status=running')
check(
  'useSdk:false falls back to the built-in TC3 signer',
  lastRequestClient === null && httpListed.json.ok === true && lastVersion === '2026-05-20',
  `X-TC-RequestClient=${JSON.stringify(lastRequestClient)} · X-TC-Version=${JSON.stringify(lastVersion)}`,
)

/* --- 14. Conversation timeouts: stall, disconnect and rejected handshake --- */
// A minimal RFC6455 server: it completes the upgrade so the client's socket opens, then
// behaves exactly like the failure modes observed on the real endpoint.
async function startSocketServer(onUpgrade) {
  // Upgraded sockets outlive `server.close()`, so they are tracked and destroyed —
  // otherwise the test process never exits.
  const sockets = []
  const server = createServer()
  server.on('upgrade', (request, socket) => {
    sockets.push(socket)
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
    onUpgrade?.(socket)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.unref()
  return {
    port: server.address().port,
    stop() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

/** One unmasked text frame, server → client. */
function sendTextFrame(socket, text) {
  const payload = Buffer.from(text, 'utf8')
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b })()])
  socket.write(Buffer.concat([header, payload]))
}

/** Run one WS turn against a fake server and report the outcome. */
async function wsTurn(port, idleTimeoutMs = 400) {
  try {
    const result = await mod.streamAdpChatWs({
      wsEndpoint: `ws://127.0.0.1:${port}/adp/v2/chat/conn/`,
      token: 'test-token',
      conversationId: 'c'.repeat(32),
      message: '你好',
      userId: 'dsh-test',
      idleTimeoutMs,
      timeoutMs: 5000,
    })
    return { ok: true, result }
  } catch (error) {
    return { ok: false, code: error?.code, message: error?.message ?? String(error), partialText: error?.partialText }
  }
}

// ① The socket opens and then stays completely silent → the stall guard must fire.
const silent = await startSocketServer(() => {})
const stallStarted = Date.now()
const stalled = await wsTurn(silent.port, 400)
const stallElapsed = Date.now() - stallStarted
silent.stop()
check(
  'a silent socket fails as ChatStalled, not as a long timeout',
  stalled.ok === false && stalled.code === 'ChatStalled',
  `${stalled.code} — ${stalled.message}`,
)
check(
  'the stall guard fires on the idle window, not the total cap',
  stallElapsed >= 400 && stallElapsed < 3000,
  `${stallElapsed}ms（idle=400ms，total=5000ms）`,
)

// ② Opening frame then an immediate disconnect → ChatWsClosed, not a timeout.
const closing = await startSocketServer((socket) => {
  sendTextFrame(socket, '0{"sid":"x","pingInterval":25000,"pingTimeout":5000}')
  setTimeout(() => { sendTextFrame(socket, '41'); socket.end() }, 60)
})
const closed = await wsTurn(closing.port, 3000)
closing.stop()
check(
  'a server-side disconnect fails fast as ChatWsClosed',
  closed.ok === false && closed.code === 'ChatWsClosed',
  `${closed.code} — ${closed.message}`,
)

// ③ A rejected handshake token → the Socket.IO connect-error frame must surface.
const rejected = await startSocketServer((socket) => {
  sendTextFrame(socket, '0{"sid":"x","pingInterval":25000,"pingTimeout":5000}')
  setTimeout(() => sendTextFrame(socket, '44{"message":"handshake token rejected"}'), 60)
})
const handshakeRefused = await wsTurn(rejected.port, 3000)
rejected.stop()
check(
  'a rejected handshake surfaces as ChatConnectError with the server text',
  handshakeRefused.ok === false && handshakeRefused.code === 'ChatConnectError'
    && handshakeRefused.message.includes('handshake token rejected'),
  `${handshakeRefused.code} — ${handshakeRefused.message}`,
)
check(
  'the timeout knobs are configurable',
  mod.DEFAULT_CONFIG.chatIdleTimeoutMs === 90000 && mod.DEFAULT_CONFIG.chatTimeoutMs === 900000,
  `idle=${mod.DEFAULT_CONFIG.chatIdleTimeoutMs} total=${mod.DEFAULT_CONFIG.chatTimeoutMs}`,
)

/* --- 15. Stable entry: a fresh implementation per activation --- */
// The entry holds no logic; it re-imports the implementation under a new `?rev=` URL on
// every activation, which is what makes a bundle toggle pick up current source without a
// DSH restart. Two activations must therefore not share module state.
const entry = await import(pathToFileURL(join(here, '..', 'lib', 'entry.js')).href)
check(
  'the bundle entry declares name and inject statically',
  entry.name === 'adp-console' && Array.isArray(entry.inject) && entry.inject.includes('tools'),
  `name=${entry.name} inject=${JSON.stringify(entry.inject)}`,
)

const entryHarness = createHarness()
entry.apply(entryHarness.ctx, {
  secretId: 'AKIDentry', secretKey: 'SECRETentry', region: 'ap-guangzhou', spaceId: 'default_space',
  site: 'standalone', endpoint: origin, chatEndpoint: '', wsEndpoint: '', protocol: 'http',
  apiVersion: '2026-05-20', routePrefix: '/adp-console', statePath: join(stateDir, 'state-entry.json'),
  defaultEnabledAppIds: [], requestTimeoutMs: 10000, releaseTimeoutMs: 5000, appKeyCacheMs: 1000,
  exposeTools: true, chatTransport: 'auto',
})
await entry.whenReady()
check(
  'activation through the entry registers its tools and route',
  entryHarness.tools.size === 5 && entryHarness.routes.length === 1,
  `tools=${entryHarness.tools.size} routes=${entryHarness.routes.length}`,
)
check(
  'the entry answers through the registered route',
  (await entryHarness.call('GET', '/config')).json.ok === true,
)

/* --- 16. Human-in-the-loop content survives the turn --- */
// A questionnaire reply carries no text, so a text-only reducer loses the question
// entirely — the panel then looks truncated exactly where the agent asked something.
const structured = await mod.runAdpChat({
  transport: 'sse',
  endpoint: `http://${origin}/adp/v2/chat`,
  appKey: 'k',
  message: '继续',
  userId: 'u',
  conversationId: 'c'.repeat(32),
})
check(
  'a questionnaire is carried out of the turn',
  Array.isArray(structured.interactions) && structured.interactions.length === 1,
  JSON.stringify(structured.interactions),
)
const form = structured.interactions?.[0]
check(
  'the questionnaire keeps its title, question and options',
  form?.kind === 'questionnaire'
    && form.title === '插图方式'
    && form.questions[0].question === 'PPT 中的插图希望采用哪种方式？'
    && form.questions[0].options.length === 2
    && form.questions[0].options[0].label === 'AI 生成插图（推荐）',
  JSON.stringify(form),
)
check(
  'the text answer is still returned alongside the form',
  structured.text === REPLY_TEXT && structured.transport === 'sse',
  JSON.stringify(structured.text),
)

/* --- 17. Chat state survives leaving the panel --- */
// Switching main panels unmounts ChatPane. State kept in `useState` was lost, so the
// conversation looked cleared on return. The shipped client keeps it in a module-level
// store keyed by app id; that store is plain JavaScript and is evaluated here as-is.
const clientSource = await readFile(join(here, '..', 'client.js'), 'utf8')
const storeStart = clientSource.indexOf('    function createChatStore() {')
const storeEnd = clientSource.indexOf('    function ChatPane(props) {')
check('the client defines an external chat store', storeStart > 0 && storeEnd > storeStart)

const storeFactory = new Function(
  `${clientSource.slice(storeStart, storeEnd)}\nreturn { createChatStore, chatStore };`,
)()
const first = storeFactory.chatStore('app-1')
let notified = 0
const unsubscribe = first.subscribe(() => { notified += 1 })
first.patch({ messages: [{ role: 'user', text: '你好' }], conversationId: 'c1' })
check('the store notifies subscribers on change', notified === 1, `notified=${notified}`)

// Remounting is exactly `chatStore(sameAppId).get()` — the data must still be there.
const remounted = storeFactory.chatStore('app-1').get()
check(
  'a remount re-attaches to the same conversation',
  remounted.messages.length === 1 && remounted.messages[0].text === '你好' && remounted.conversationId === 'c1',
  JSON.stringify(remounted.messages),
)
check(
  'functional updates still work through the store',
  (() => {
    first.patch(state => ({ ...state, messages: [...state.messages, { role: 'agent', text: '在' }] }))
    return storeFactory.chatStore('app-1').get().messages.length === 2
  })(),
)
check(
  'each app gets its own store',
  storeFactory.chatStore('app-2').get().messages.length === 0
    && storeFactory.chatStore('app-1').get().messages.length === 2,
)
check(
  'the user id is stable across remounts',
  storeFactory.chatStore('app-1').get().userId === remounted.userId,
)
check(
  'the pane does not abort its turn when unmounted',
  !/useEffect\(\(\) => \(\) => \{ abortRef\.current\?\.abort/.test(clientSource)
    && !/\babortRef\b/.test(clientSource),
  'abortRef still present',
)
unsubscribe()
check('unsubscribing stops notifications', (() => {
  const before = notified
  first.patch({ draft: 'x' })
  return notified === before
})())

// The selected app has to survive too: `current` is derived from it, so losing it would
// show an empty pane even with the store intact.
check(
  'the selected app survives leaving the panel',
  /let lastSelectedAppId = ''/.test(clientSource)
    && /useState\(\(\) => lastSelectedAppId\)/.test(clientSource)
    && /lastSelectedAppId = appId/.test(clientSource),
)
check(
  'the pane reads its conversation state from the store, not useState',
  !/const \[messages, setMessages\] = useState/.test(clientSource)
    && /useSyncExternalStore\(store\.subscribe, store\.get\)/.test(clientSource),
)
check(
  'selecting another app does not wipe a stored conversation',
  (() => {
    const a = storeFactory.chatStore('keep-a')
    a.patch({ messages: [{ role: 'user', text: 'hi' }] })
    storeFactory.chatStore('keep-b').patch({ draft: 'typing' })
    return storeFactory.chatStore('keep-a').get().messages.length === 1
      && storeFactory.chatStore('keep-b').get().draft === 'typing'
  })(),
)

/* --- 18. One turn, several replies, separated paragraphs --- */
// Each narration step is its own `reply` message; joining them without a separator
// produced the run-on wall of text the panel used to show.
const streamed = []
const multi = await mod.runAdpChat({
  transport: 'sse',
  endpoint: `http://${origin}/adp/v2/chat`,
  appKey: 'k',
  message: 'MULTI',
  userId: 'u',
  conversationId: 'c'.repeat(32),
  onEvent: (name, payload, text) => { if (text !== '') streamed.push(text) },
})
check(
  'separate replies become separate paragraphs',
  multi.text === '第一批资料已获取。\n\n继续搜索验证关键数据。',
  JSON.stringify(multi.text),
)
check(
  'the streamed deltas carry the paragraph break too',
  streamed.join('') === multi.text,
  JSON.stringify(streamed),
)
check(
  'a single reply is not given a spurious break',
  structured.text === REPLY_TEXT,
  JSON.stringify(structured.text),
)

/* --- 19. The `@` mention bridge: one prompt, one ADP app --- */
// The second conversation path. `@` an enabled app and the turn is answered by that
// app through the documented `llm/stream` routing seam instead of by the model. The
// prompt carries only the readable `@name`; the id arrives out of band at pick time,
// and a hand-typed `@name` falls back to the enabled-app index.
const mentionHarness = createHarness()
mod.apply(mentionHarness.ctx, {
  secretId: 'AKIDmention', secretKey: 'SECRETmention', region: 'ap-guangzhou', spaceId: 'default_space',
  site: 'standalone', endpoint: origin, chatEndpoint: `http://${origin}/adp/v2/chat`, wsEndpoint: '',
  protocol: 'http', apiVersion: '2026-05-20', routePrefix: '/adp-console',
  statePath: join(stateDir, 'state-mention.json'), defaultEnabledAppIds: [APP_RUNNING],
  requestTimeoutMs: 10000, releaseTimeoutMs: 5000, appKeyCacheMs: 300000,
  exposeTools: false, chatTransport: 'sse',
})

check('the `@` bridge is on by default', mod.DEFAULT_CONFIG.mentionEnabled === true)
check(
  'a multi-word app name becomes one mention token',
  mod.mentionToken('Customer Service Bot') === 'Customer-Service-Bot',
  mod.mentionToken('Customer Service Bot'),
)
check('an unnamed app falls back to its id', mod.mentionToken('', APP_RUNNING) === APP_RUNNING)
check(
  'mentions are whitespace-bounded, exactly as the Chat view decorates them',
  mod.mentionTokensIn('@客服助手 你好，@DSH').map(token => token.name).join('|') === '客服助手',
  JSON.stringify(mod.mentionTokensIn('@客服助手 你好，@DSH')),
)
check('removing a mention leaves the prose', mod.removeMentionToken('@客服助手 帮我看下数据', '客服助手') === '帮我看下数据')

const mentionApps = await mentionHarness.call('GET', '/mention-apps')
check(
  'GET /mention-apps lists the enabled, running apps by their mention token',
  mentionApps.json.ok === true && mentionApps.json.apps.length === 1
    && mentionApps.json.apps[0].appId === APP_RUNNING && mentionApps.json.apps[0].token === '客服助手',
  JSON.stringify(mentionApps.json),
)
check('GET /mention-apps offers the way out of ADP mode', mentionApps.json.exit?.token === 'DSH', JSON.stringify(mentionApps.json.exit))
check(
  'the menu copy stays localizable instead of being stringified',
  mentionApps.json.apps[0].adpStatus === 2
    && mentionApps.json.apps[0].adpStatusLabel?.zh === '已上线'
    && mentionApps.json.apps[0].appModeLabel?.zh === 'Agent 模式',
  JSON.stringify(mentionApps.json.apps[0]),
)
check(
  'without credentials the @ menu reports that instead of failing',
  (await secondary.call('GET', '/mention-apps')).json.configured === false,
)

const SESSION = 'session-mention-1'
const bind = await mentionHarness.call('POST', '/bind', JSON.stringify({ sessionId: SESSION, appId: APP_RUNNING, token: '客服助手' }))
check('POST /bind arms an enabled app', bind.json.ok === true && bind.json.appId === APP_RUNNING, JSON.stringify(bind.json))
check(
  'POST /bind refuses an app that is not 上架',
  (await mentionHarness.call('POST', '/bind', JSON.stringify({ sessionId: 'session-unarmed', appId: APP_OFFLINE, token: '知识问答' }))).json.ok === false,
)

const userOf = (id, text) => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text }] })
const preStep = (harness, sessionId, messages) => harness.waterfall(
  'agent/pre-step',
  { agent: { session: { id: sessionId } }, messages, turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages }),
)
const collect = async (iterable) => {
  const chunks = []
  for await (const chunk of await iterable) chunks.push(chunk)
  return chunks
}
/** Drive one model call; `fellThrough` records that the adapter was asked instead. */
async function streamTurn(harness, sessionId, overrides = {}) {
  let fellThrough = false
  const chunks = await collect(harness.waterfall(
    'llm/stream',
    { provider: 'deepseek-official', model: 'test', sessionId, messages: [], ...overrides },
    () => {
      fellThrough = true
      return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
    },
  ))
  return { chunks, fellThrough }
}
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')

const firstDecision = await preStep(mentionHarness, SESSION, [userOf('m1', '@客服助手 帮我看下数据')])
check(
  'the mention never reaches the model prompt',
  mod.messageTextOf(firstDecision.messages[0]) === '帮我看下数据',
  JSON.stringify(mod.messageTextOf(firstDecision.messages[0])),
)
check('the pre-step keeps its own decision shape', firstDecision.kind === 'enter' && firstDecision.messages.length === 1)

const createsBefore = conversationCreateCount
const firstTurn = await streamTurn(mentionHarness, SESSION)
check(
  'the turn is answered by the ADP app, not by the model',
  firstTurn.fellThrough === false && textOf(firstTurn.chunks).includes(REPLY_TEXT),
  textOf(firstTurn.chunks).slice(0, 120),
)
check(
  'the ADP turn received the prose without its mention',
  globalThis.__lastChatBody?.Contents?.[0]?.Text === '帮我看下数据',
  JSON.stringify(globalThis.__lastChatBody?.Contents),
)
check(
  'the bridged turn opens one ADP conversation',
  conversationCreateCount === createsBefore + 1 && globalThis.__lastChatBody?.ConversationId === CONVERSATION_ID,
  `creates=${conversationCreateCount - createsBefore}`,
)
check(
  'the end user is stable per session, not per turn',
  typeof globalThis.__lastChatBody?.UserId === 'string' && globalThis.__lastChatBody.UserId.startsWith('dsh'),
  String(globalThis.__lastChatBody?.UserId),
)
check(
  'the reply streams as the documented chunk vocabulary',
  firstTurn.chunks[0].type === 'block-start'
    && firstTurn.chunks.at(-1).type === 'finish' && firstTurn.chunks.at(-1).reason.kind === 'stop'
    && firstTurn.chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text.includes(REPLY_TEXT)),
  JSON.stringify(firstTurn.chunks.map(chunk => chunk.type)),
)
check(
  'a human-in-the-loop form is rendered as answerable text',
  textOf(firstTurn.chunks).includes('插图方式') && textOf(firstTurn.chunks).includes('AI 生成插图（推荐）'),
  textOf(firstTurn.chunks).slice(-160),
)

await preStep(mentionHarness, SESSION, [userOf('m2', '再详细一点')])
const followTurn = await streamTurn(mentionHarness, SESSION)
check(
  'a follow-up with no mention stays with the same app',
  followTurn.fellThrough === false && textOf(followTurn.chunks).includes(REPLY_TEXT),
  textOf(followTurn.chunks).slice(0, 80),
)
check(
  'the follow-up reuses the conversation it opened',
  conversationCreateCount === createsBefore + 1,
  `creates=${conversationCreateCount - createsBefore}`,
)
const titled = await streamTurn(mentionHarness, SESSION, { purpose: 'session-title' })
check('an auxiliary model call is never routed to the app', titled.fellThrough === true)

await mentionHarness.call('POST', '/bind', JSON.stringify({ sessionId: SESSION, appId: null, token: 'DSH' }))
const exitDecision = await preStep(mentionHarness, SESSION, [userOf('m3', '@DSH 你好')])
check(
  'the exit mention is stripped from the prompt too',
  mod.messageTextOf(exitDecision.messages[0]) === '你好',
  JSON.stringify(mod.messageTextOf(exitDecision.messages[0])),
)
const exited = await streamTurn(mentionHarness, SESSION)
check('after the exit the model owns the turn again', exited.fellThrough === true)

// A mention typed or pasted by hand has no pick behind it; the enabled-app index is
// what keeps it working, which is also what makes a mention survive being copied.
const typed = await preStep(mentionHarness, 'session-mention-typed', [userOf('t1', '@客服助手 你好')])
check('a hand-typed mention resolves against the enabled apps', mod.messageTextOf(typed.messages[0]) === '你好')
const typedTurn = await streamTurn(mentionHarness, 'session-mention-typed')
check('...and routes to the same app', typedTurn.fellThrough === false && textOf(typedTurn.chunks).includes(REPLY_TEXT))

// `@DSH` typed by hand is the same exit the menu row performs.
const typedExit = await preStep(mentionHarness, 'session-mention-typed', [userOf('t2', '@DSH 换我问你')])
check(
  'a hand-typed @DSH also releases the session',
  mod.messageTextOf(typedExit.messages[0]) === '换我问你' && (await streamTurn(mentionHarness, 'session-mention-typed')).fellThrough === true,
)

// 下架 after the bind: the gate outranks the binding, and the answer says why.
await mentionHarness.call('POST', '/bind', JSON.stringify({ sessionId: 'session-mention-off', appId: APP_RUNNING, token: '客服助手' }))
await preStep(mentionHarness, 'session-mention-off', [userOf('d1', '@客服助手 你好')])
await mentionHarness.call('POST', '/enabled', JSON.stringify({ appId: APP_RUNNING, enabled: false }))
const offTurn = await streamTurn(mentionHarness, 'session-mention-off')
check(
  'a 下架 app answers with the gate message instead of a reply',
  offTurn.fellThrough === false && textOf(offTurn.chunks).includes('未上架'),
  textOf(offTurn.chunks).slice(0, 140),
)
await mentionHarness.call('POST', '/enabled', JSON.stringify({ appId: APP_RUNNING, enabled: true }))

// `mentionEnabled: false` removes the Host listeners and tells the Client to drop the
// menu group, so nothing can insert a mention that no longer resolves.
const offHarness = createHarness()
mod.apply(offHarness.ctx, {
  secretId: 'AKIDoff', secretKey: 'SECREToff', region: 'ap-guangzhou', spaceId: 'default_space',
  site: 'standalone', endpoint: origin, chatEndpoint: `http://${origin}/adp/v2/chat`, protocol: 'http',
  apiVersion: '2026-05-20', routePrefix: '/adp-console', statePath: join(stateDir, 'state-mention-off.json'),
  defaultEnabledAppIds: [APP_RUNNING], requestTimeoutMs: 10000, releaseTimeoutMs: 5000,
  appKeyCacheMs: 1000, exposeTools: false, mentionEnabled: false,
})
const offRoute = await offHarness.call('GET', '/mention-apps')
check('mentionEnabled:false tells the Client to drop the @ group', offRoute.json.bridge === false)
await preStep(offHarness, 'session-mention-disabled-bridge', [userOf('o1', '@客服助手 你好')])
check(
  'mentionEnabled:false leaves the model owning every turn',
  (await streamTurn(offHarness, 'session-mention-disabled-bridge')).fellThrough === true,
)

/* --- 20. The Client `@` source --- */
// `client.js` is plain JavaScript the page evaluates through its module table, so this
// runs the shipped source: whatever it registers here is what the composer will see.
let handoff
const previousWindow = globalThis.window
globalThis.window = { __ModuleLoader__: { load: registration => { handoff = registration } } }
await import(`${pathToFileURL(join(here, '..', 'client.js')).href}?rev=${Date.now()}`)
globalThis.window = previousWindow
check(
  'the client registers its module factory',
  handoff?.id === '@local/adp-console' && typeof handoff?.factory === 'function',
  String(handoff?.id),
)

const reactStub = {
  createElement: () => null,
  createContext: () => ({ Provider: () => null, Consumer: () => null }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useRef: value => ({ current: value ?? null }),
  useSyncExternalStore: () => undefined,
  Fragment: 'Fragment',
}
const clientPlugin = handoff.factory((id) => {
  if (id === 'react') return reactStub
  throw new Error(`unexpected require(${JSON.stringify(id)})`)
})
const sources = []
const inputTriggers = { registerSource(source) { sources.push(source); return () => {} } }
const clientCtx = {
  effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
  get(name) { return name === 'inputTriggers' ? inputTriggers : undefined },
  inject(_dependencies, callback) { callback({ ...clientCtx, inputTriggers }) },
  on() { return () => {} },
  locale: { register() {}, bind: () => key => key },
  slots: { inject() {}, register: () => () => {} },
}
clientPlugin.apply(clientCtx)
check(
  'applying the client half registers one `@` source',
  sources.length === 1 && sources[0].trigger === '@' && sources[0].name === 'adp',
  `${sources.length} source(s)`,
)

const realFetch = globalThis.fetch
const clientCalls = []
globalThis.fetch = async (url, options) => {
  const target = String(url)
  clientCalls.push({ target, options })
  const json = value => ({ ok: true, status: 200, json: async () => value })
  if (target === '/adp-console/mention-apps') {
    return json({
      ok: true,
      configured: true,
      apps: [{ appId: APP_RUNNING, name: '客服助手', token: '客服助手', appModeLabel: { zh: 'Agent 模式' }, adpStatus: 2 }],
      exit: { token: 'DSH', label: 'DSH 本体' },
    })
  }
  if (target === '/adp-console/bind') return json({ ok: true })
  return realFetch(url, options)
}
try {
  const source = sources[0]
  const session = { sessionId: 's-client' }
  const rows = await source.candidates(session, { query: '', signal: new AbortController().signal, position: 'inline', drilled: false })
  check(
    'the @ menu offers the enabled app and a way back to DSH',
    rows.length === 2 && rows[0].name === '客服助手' && rows[1].name === 'DSH 本体',
    JSON.stringify(rows.map(row => row.name)),
  )
  const filtered = await source.candidates(session, { query: '知识', signal: new AbortController().signal, position: 'inline', drilled: false })
  check(
    'the @ menu filters by name',
    filtered.length === 1 && JSON.parse(filtered[0].value).kind === 'exit',
    JSON.stringify(filtered.map(row => row.name)),
  )
  check(
    'the menu describes the app without stringifying its labels',
    typeof rows[0].description === 'string' && rows[0].description.includes('Agent 模式')
      && !rows[0].description.includes('[object'),
    String(rows[0].description),
  )
  const pick = source.onPick({ candidate: rows[0], session, position: 'inline', via: 'menu', action: 'pick', span: {} })
  check(
    'a pick inserts a chip labelled with the app name',
    pick?.insert?.appearance === 'session' && pick.insert.label === '客服助手' && pick.insert.source === 'adp',
    JSON.stringify(pick),
  )
  check(
    'the chip serializes to the readable @name the Host resolves',
    await source.codec.serialize(pick.insert.ref, new AbortController().signal) === '@客服助手',
    pick.insert.ref,
  )
  const bindCall = clientCalls.find(call => call.target === '/adp-console/bind')
  check(
    'the pick tells the Host which app it means, before the message is sent',
    bindCall !== undefined
      && JSON.parse(bindCall.options.body).appId === APP_RUNNING
      && JSON.parse(bindCall.options.body).sessionId === 's-client',
    JSON.stringify(bindCall?.options?.body),
  )
  const exitPick = source.onPick({ candidate: rows[1], session, position: 'inline', via: 'menu', action: 'pick', span: {} })
  check(
    'the exit row clears the binding and serializes to @DSH',
    await source.codec.serialize(exitPick.insert.ref, new AbortController().signal) === '@DSH'
      && JSON.parse(clientCalls.filter(call => call.target === '/adp-console/bind').at(-1).options.body).appId === null,
  )
  check(
    'a hint row inserts nothing',
    source.onPick({
      candidate: { name: 'hint', value: JSON.stringify({ kind: 'hint' }) },
      session, position: 'inline', via: 'menu', action: 'pick', span: {},
    }) === 'handled',
  )
} finally {
  globalThis.fetch = realFetch
}

/* --- 19. Markdown rendering, mirroring the host assistant message --- */
// A workspace Client half cannot import the Host's MarkdownText, so the plugin ships its
// own renderer. It is pure given `h` and React, so the shipped source is evaluated here
// and exercised directly.
const mdStart = clientSource.indexOf('    /* ------------------------------------------------------------------ *\n     * Markdown, mirroring')
const mdEnd = clientSource.indexOf('    /**\n     * Render one structured interaction from an ADP turn.')
check('the client ships a markdown renderer', mdStart > 0 && mdEnd > mdStart)

const mdFactory = new Function('h', 'React', `
${clientSource.slice(mdStart, mdEnd)}
return { blockNodes, inlineNodes };
`)
const stubH = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })
const md = mdFactory(stubH, { useMemo: fn => fn() })

/** Flatten rendered nodes into `[tag, text]` pairs for assertions. */
const flatten = (nodes) => nodes.flatMap((node) => {
  if (node === null || node === undefined || typeof node === 'string') return [node].filter(Boolean)
  return [node.type, ...flatten(node.children)]
})
const tagsOf = (markdown) => md.blockNodes(markdown, 'k').map(node => node.type)
/** Every anchor destination, which lives in props rather than children. */
const hrefsOf = (nodes) => nodes.flatMap((node) => {
  if (node === null || node === undefined || typeof node === 'string') return []
  const own = node.type === 'a' && node.props && node.props.href ? [node.props.href] : []
  return [...own, ...hrefsOf(node.children)]
})

check(
  'bold, code and links become elements instead of literal markers',
  (() => {
    const nodes = md.blockNodes('加粗 **重点** 与 `代码` 和 [链接](https://example.com)', 'k')
    const flat = flatten(nodes)
    return flat.includes('strong') && flat.includes('code') && flat.includes('a')
      && hrefsOf(nodes).includes('https://example.com')
      && !flat.join('').includes('**')
  })(),
)
check(
  'CJK text keeps working next to emphasis (the host has a dedicated extension)',
  flatten(md.blockNodes('**中文加粗**后面直接接中文', 'k')).includes('strong'),
)
check('headings map to h1..h6', JSON.stringify(tagsOf('# 一\n\n### 三')) === JSON.stringify(['h1', 'h3']))
check(
  'unordered and ordered lists become ul/ol with their items',
  JSON.stringify(tagsOf('- 甲\n- 乙\n\n1. 一\n2. 二')) === JSON.stringify(['ul', 'ol']),
)
check(
  'fenced code becomes a pre block',
  (() => {
    const nodes = md.blockNodes('```js\nconst a = 1\n```', 'k')
    return nodes.length === 1 && nodes[0].type === 'pre'
      && flatten(nodes).includes('const a = 1')
  })(),
)
check(
  'a pipe table becomes a real table',
  (() => {
    const nodes = md.blockNodes('| 名称 | 值 |\n| --- | --- |\n| 甲 | 1 |', 'k')
    const flat = flatten(nodes)
    return nodes[0].type === 'div' && flat.includes('table') && flat.includes('th') && flat.includes('td')
      && flat.includes('名称') && flat.includes('甲')
  })(),
)
check('blockquotes and rules are recognised', JSON.stringify(tagsOf('> 引用\n\n---')) === JSON.stringify(['blockquote', 'hr']))
check(
  'blank lines split paragraphs, a lone newline stays a soft break',
  (() => {
    const nodes = md.blockNodes('第一段\n\n第二句\n仍然同一段', 'k')
    return nodes.length === 2 && nodes[0].type === 'p' && nodes[1].type === 'p'
  })(),
)
check(
  'non-http destinations never become anchors',
  hrefsOf(md.blockNodes('[x](javascript:alert(1))', 'k')).length === 0
    && !flatten(md.blockNodes('[x](javascript:alert(1))', 'k')).includes('a'),
)
check(
  'the paragraph break from separate replies survives rendering',
  md.blockNodes('第一批资料已获取。\n\n继续搜索。', 'k').length === 2,
)

gateway.close()

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failed:')
  for (const result of failed) console.log(`  - ${result.name}`)
  process.exitCode = 1
}
