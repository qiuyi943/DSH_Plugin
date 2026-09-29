/**
 * ADP Console — Host half.
 *
 * Owns three things:
 *  1. A Tencent Cloud ADP OpenAPI client (TC3-HMAC-SHA256 over `adp.tencentcloudapi.com`),
 *     used to read the *published* agent-app catalogue and to publish an app.
 *  2. The DSH-callability gate: which catalogue apps this Harness may call.
 *     "上架 / enable" means "DSH may call this app"; "下架 / disable" means it may not.
 *     The gate is plugin-owned state, persisted as JSON, and it is enforced in every
 *     path that can reach the ADP conversation API (tools and the browser route).
 *  3. The agent-facing tools and the same-origin browser route the Client panel uses.
 *  4. The `@` mention bridge: a prompt that names an enabled app is answered by that
 *     app, through the `llm/stream` routing seam, instead of by the model.
 *
 * The ADP conversation call itself is the HTTP SSE endpoint documented at
 * https://cloud.tencent.com/document/product/1759/129202
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'adp-console'

/** The tool registry is the only hard dependency; the HTTP route is optional. */
export const inject = ['tools']

/**
 * Defaults for the row's `config`.
 *
 * This bundle deliberately exports no `Config` schema: a workspace bundle resolves no
 * package outside its own directory, and `@deepseek-ai/schemastery` is not reachable
 * from here. The raw row config is read directly instead, and everything a user must
 * change at runtime lives in the panel's settings form (persisted beside the gate).
 */
export const DEFAULT_CONFIG = {
  /** Tencent Cloud API SecretId. Falls back to TENCENTCLOUD_SECRET_ID. */
  secretId: '',
  /** Tencent Cloud API SecretKey. Falls back to TENCENTCLOUD_SECRET_KEY. */
  secretKey: '',
  /** ADP region. `ap-guangzhou` is the only public region. */
  region: 'ap-guangzhou',
  /** ADP space id; `default_space` is the platform default. */
  spaceId: 'default_space',
  /** Deployment site: `cn` (腾讯云) | `intl` (国际站) | `standalone` (ADP 独立站). */
  site: 'cn',
  /** Explicit OpenAPI host; empty = derived from `site`. */
  endpoint: '',
  /** OpenAPI scheme; `http` is only useful against a local mock gateway. */
  protocol: 'https',
  /** OpenAPI version. */
  apiVersion: '2026-05-20',
  /** Explicit conversation (HTTP SSE) URL; empty = derived from `site`. */
  chatEndpoint: '',
  /** Explicit conversation (Socket.IO) URL; empty = derived from `site`. */
  wsEndpoint: '',
  /**
   * Which conversation transport to use: `auto` tries SSE and falls back to the
   * Socket.IO channel when the SSE service cannot resolve the app, `sse`/`ws` force one.
   */
  chatTransport: 'auto',
  /**
   * Stall guard: no frame at all (heartbeats included) for this long means the
   * connection is dead. The server pings every 25s, so this tolerates ~3 missed
   * heartbeats before giving up on a turn that is otherwise still running.
   */
  chatIdleTimeoutMs: 90000,
  /** Absolute cap for one conversation turn. Claw-mode tasks can legitimately run minutes. */
  chatTimeoutMs: 900000,
  /** Same-origin route prefix the Client panel talks to. */
  routePrefix: '/adp-console',
  /** Path of the persisted gate and credentials. Empty = $DSH_HOME/adp-console/state.json. */
  statePath: '',
  /** Apps enabled at first run, before any user toggle. */
  defaultEnabledAppIds: [],
  /** Per-OpenAPI-call timeout. */
  requestTimeoutMs: 20000,
  /** How long to wait for a release task to settle. */
  releaseTimeoutMs: 90000,
  /** Cache lifetime for a resolved app AppKey. */
  appKeyCacheMs: 300000,
  /** Register the agent-facing tools. */
  exposeTools: true,
  /**
   * Register the `@` bridge: `@` an enabled app in a session and that turn is answered
   * by the app instead of the model. `false` registers neither Host listener and reports
   * `bridge:false`, which is what makes the Client drop its `@` group; the panel and the
   * tools are untouched.
   */
  mentionEnabled: true,
  /**
   * How long a `@` pick stays armed for the message that carries it. The pick resolves
   * the app up front (the prompt itself only carries the readable `@name`), so the arm
   * has to survive the typing between the pick and the send.
   */
  mentionPickTtlMs: 1800000,
  /** How long the enabled-app name index used to resolve a hand-typed mention is reused. */
  mentionIndexMs: 60000,
  /**
   * Prefer the official `tencentcloud-sdk-nodejs-adp` for management calls.
   * When it is not installed the plugin falls back to its built-in TC3 signer.
   */
  useSdk: true,
}

/**
 * Deployment sites.
 * A key exists on exactly one of them, so a key from the wrong site looks identical
 * to a deleted key (`AuthFailure.SecretIdNotFound`).
 *
 * The 独立站 (standalone) site uses the same API version, the same Actions, the same
 * V3 signature and the same `ap-guangzhou` region as the Tencent Cloud site — only the
 * request domain and the key source differ:
 * https://cloud.tencent.com/document/product/1759/133868 (API 版本与端点)
 */
export const SITES = {
  cn: {
    label: '中国站',
    keySource: '腾讯云 CAM 控制台',
    endpoint: 'adp.tencentcloudapi.com',
    chatEndpoint: 'https://wss.lke.cloud.tencent.com/adp/v2/chat',
    wsEndpoint: 'wss://wss.lke.cloud.tencent.com/adp/v2/chat/conn/',
  },
  intl: {
    label: '国际站',
    keySource: '国际站控制台',
    endpoint: 'adp.intl.tencentcloudapi.com',
    chatEndpoint: 'https://wss.lke.tencentcloud.com/adp/v2/chat',
    wsEndpoint: 'wss://wss.lke.tencentcloud.com/adp/v2/chat/conn/',
  },
  standalone: {
    label: '独立站',
    keySource: 'ADP 控制台 > 密钥管理',
    endpoint: 'capi.adp.tencent.com',
    // The standalone conversation stream lives on its own host (the management gateway
    // `capi` would answer 401 without a V3 Authorization header), and its WebSocket
    // channel is served from the shared LKE host — both verified against a real app.
    // https://cloud.tencent.com/document/product/1759/133869
    chatEndpoint: 'https://adp.tencent.com/adp/v2/chat',
    wsEndpoint: 'wss://wss.lke.cloud.tencent.com/adp/v2/chat/conn/',
  },
}

/** Sites a credential probe can target, in the order the verifier tries them. */
const PROBE_SITES = ['cn', 'intl', 'standalone']

/* ------------------------------------------------------------------ *
 * ADP application status vocabulary (DescribeAppSummaryList FilterList)
 * ------------------------------------------------------------------ */

/** ADP `AppStatus` enum. */
export const APP_STATUS = { OFFLINE: 1, RUNNING: 2, DISABLED: 3 }
/** ADP `AppMode` enum. */
export const APP_MODE = { STANDARD: 1, AGENT: 2, SINGLE_WORKFLOW: 3, CLAW_AGENT: 4 }

const APP_STATUS_LABEL = {
  1: { zh: '未上线', en: 'Offline' },
  2: { zh: '已上线', en: 'Running' },
  3: { zh: '已停用', en: 'Disabled' },
  4: { zh: '导入中', en: 'Importing' },
}

/**
 * `ReleaseSummary.Status` vocabulary.
 * `terminal` marks a status the release task never leaves on its own.
 */
const RELEASE_STATUS = {
  1: { key: 'pending', zh: '待发布', terminal: false },
  2: { key: 'releasing', zh: '发布中', terminal: false },
  3: { key: 'success', zh: '发布成功', terminal: true },
  4: { key: 'failed', zh: '发布失败', terminal: true },
  5: { key: 'reviewing', zh: '审核中', terminal: false },
  6: { key: 'review-passed', zh: '审核成功', terminal: false },
  7: { key: 'review-failed', zh: '审核失败', terminal: true },
  8: { key: 'callback', zh: '发布成功回调处理中', terminal: false },
  9: { key: 'paused', zh: '发布暂停', terminal: true },
  10: { key: 'appealing', zh: '申诉审核中', terminal: false },
  11: { key: 'appeal-passed', zh: '申诉审核通过', terminal: true },
  12: { key: 'appeal-failed', zh: '申诉审核不通过', terminal: true },
}

const APP_MODE_LABEL = {
  1: { zh: '标准模式', en: 'Standard' },
  2: { zh: 'Agent 模式', en: 'Agent' },
  3: { zh: '单工作流模式', en: 'Single workflow' },
  4: { zh: 'ClawAgent 模式', en: 'ClawAgent' },
}

/* ------------------------------------------------------------------ *
 * TC3-HMAC-SHA256
 * ------------------------------------------------------------------ */

/** Lowercase hex SHA-256 of a UTF-8 string. */
function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Raw HMAC-SHA256 digest. */
function hmac(key, input) {
  return createHmac('sha256', key).update(input, 'utf8').digest()
}

/**
 * Build the `Authorization` header for one Tencent Cloud API 3.0 request.
 *
 * `content-type`, `host` and `x-tc-action` are signed, matching the worked example in
 * https://cloud.tencent.com/document/api/1759/132550 (signing the action binds the
 * signature to one API call).
 * @param options - credentials, endpoint, action, payload and clock reading.
 * @returns every header the request needs, including `Authorization`.
 */
export function buildTc3Headers(options) {
  const { secretId, secretKey, endpoint, action, version, region, payload, timestamp } = options
  const service = options.service ?? 'adp'
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  // `body` lets a caller hand over the exact serialised payload; the signature covers
  // whatever bytes are sent, so the two must stay identical.
  const body = options.body ?? JSON.stringify(payload)

  const canonicalHeaderMap = {
    'content-type': 'application/json; charset=utf-8',
    host: endpoint,
    'x-tc-action': String(action).toLowerCase(),
  }
  const signedHeaderNames = Object.keys(canonicalHeaderMap).sort()
  const canonicalHeaders = signedHeaderNames.map(name => `${name}:${canonicalHeaderMap[name]}\n`).join('')
  const signedHeaders = signedHeaderNames.join(';')
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(body)].join('\n')

  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(`TC3${secretKey}`, date)
  const kService = hmac(kDate, service)
  const kSigning = hmac(kService, 'tc3_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(timestamp),
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
  if (region) headers['X-TC-Region'] = region
  return { headers, body }
}

/* ------------------------------------------------------------------ *
 * ADP OpenAPI calls
 * ------------------------------------------------------------------ */

/** Error carrying the ADP error code so callers can react to it. */
export class AdpError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'AdpError'
    this.code = options.code
    this.requestId = options.requestId
    this.action = options.action
  }
}

/**
 * Actionable guidance for the credential failures users actually hit.
 * `SecretIdNotFound` is not ADP-specific: the same key is rejected by every product,
 * so the text must send the reader to the key management page rather than to ADP.
 */
const AUTH_HINTS = {
  'AuthFailure.SecretIdNotFound':
    '腾讯云不认识这个 SecretId（它对中国站的其它产品同样报同样的错，所以不是 ADP 的问题）。请到 '
    + 'https://console.cloud.tencent.com/cam/capi 重新复制 SecretId，或直接新建一对密钥；'
    + '若密钥来自国际站，请改用国际站端点。',
  'AuthFailure.SignatureFailure':
    'SecretKey 与 SecretId 不匹配。请确认两个值来自同一对密钥。',
  'AuthFailure.SignatureExpire':
    '本机时间与标准时间相差超过 5 分钟，请校准系统时间。',
  'AuthFailure.TokenFailure':
    '这是一个临时密钥（STS），需要同时提供 Token；本插件只支持长期密钥。',
  'AuthFailure.UnauthorizedOperation':
    '密钥有效，但没有调用该接口的权限。请在访问管理里给这个账号/子账号授予 ADP 相关权限。',
  UnauthorizedOperation:
    '密钥有效，但没有调用该接口的权限。请在访问管理里给这个账号/子账号授予 ADP 相关权限。',
  'FailedOperation.NotAllowed':
    '该账号可能尚未开通 ADP（智能体开发平台），或未加入对应空间。',
  'InvalidParameterValue.SpaceIdNotFound':
    '空间 ID 不存在。请把面板设置里的「空间 ID」改成实际的空间（默认是 default_space）。',
}

/**
 * Message-aware hints.
 * The 独立站 funnels most business failures through `Error.Code = FailedOperation` and
 * puts the real reason in `Message` as a numeric prefix, so the code alone cannot
 * identify the cause.
 */
const MESSAGE_HINTS = [
  {
    match: /ErrSecretNotFound/i,
    hint: '独立站的密钥管理里没有这把密钥：请到 https://adp.tencent.com/adp#/key-manage 重新获取'
      + '（独立站不使用腾讯云 CAM 密钥）。',
  },
  {
    // 4510004: the space exists as a *name* but not as the id handed to the API.
    match: /\b4510004\b/,
    hint: '空间 ID 不对：独立站上 `default_space` 只是空间的「名字」，接口要的是 SpaceId（形如 `bfnUUoSh`）。'
      + '用插件工具 `adp_list_spaces`、路由 `GET /adp-console/spaces`，或 `node test/spaces.mjs` 列出真实 SpaceId，'
      + '再填进面板「设置 → 空间 ID」。',
  },
  {
    match: /ErrSpaceNotFound/i,
    hint: '该空间不存在或这把密钥无权访问：用 `adp_list_spaces` 列出可用的 SpaceId。',
  },
  {
    // Known to the conversation service but with no published version.
    match: /\b460048\b|应用未发布/,
    hint: '对话服务认识这个应用，但它还没有已发布的版本：先发布（`adp_publish_app` 或控制台）再对话。',
  },
  {
    // The conversation backend cannot resolve the app even though the management API
    // accepts the very same AppKey (`CreateConversation` with Type=5 rejects a wrong key).
    // Reproduced on the 独立站: an app answering 460048 (known, unpublished) starts
    // answering 460004 (unknown) right after a successful CreateRelease, with an
    // unchanged AppKey — so the release did not register the bot in the conversation service.
    match: /\b460004\b|机器人不存在|应用不存在/,
    hint: '对话服务没有登记这个应用：管理接口认可这把 AppKey（乱填的会被拒），但对话后台找不到它。'
      + '独立站上已复现：发布成功（Status=3）后反而从 `460048 应用未发布` 变成 `460004`，而 AppKey 未变，'
      + '说明发布没有把机器人登记到对话服务。请到控制台对该应用再点一次「发布」，'
      + '用控制台的「调用」验证；若控制台也调不通，属于平台侧登记缺陷，需要 ADP 支持介入。',
  },
]

/** Append the matching hint to an API error message. */
export function describeApiError(prefix, error) {
  const byMessage = MESSAGE_HINTS.find(entry => entry.match.test(String(error.Message ?? '')))
  const hint = byMessage?.hint ?? AUTH_HINTS[error.Code]
  return `${prefix}: ${error.Code} — ${error.Message}${hint === undefined ? '' : `\n\n${hint}`}`
}

/* ------------------------------------------------------------------ *
 * Official ADP SDK (tencentcloud-sdk-nodejs-adp)
 * ------------------------------------------------------------------ */

/**
 * The official Tencent Cloud ADP SDK, loaded lazily.
 *
 * The docs' quickstart installs the product SDK and lets it sign every management
 * call (`pip install tencentcloud-sdk-python-adp` there; the Node twin here):
 * https://cloud.tencent.com/document/product/1759/133869
 *
 * It is optional by design — a fresh checkout without `node_modules` still works
 * through the built-in TC3 signer below — so the load never throws.
 * @returns the `adp.v20260520.Client` constructor, or null when unavailable.
 */
let sdkConstructorPromise
function loadAdpSdk(enabled) {
  if (!enabled) return Promise.resolve(null)
  if (sdkConstructorPromise === undefined) {
    sdkConstructorPromise = import('tencentcloud-sdk-nodejs-adp')
      .then((module) => {
        const sdk = module.default ?? module
        return sdk?.adp?.v20260520?.Client ?? null
      })
      .catch((error) => {
        console.warn(`[adp-console] 官方 SDK 不可用，回退到内置 TC3 签名：${error.code ?? error.message}`)
        return null
      })
  }
  return sdkConstructorPromise
}

/** One SDK client per credential + endpoint combination. */
const sdkClients = new Map()

/** Get (or build) the SDK client for one target. */
function sdkClientFor(SdkClient, target) {
  const key = [target.secretId, target.region, target.endpoint, target.protocol].join('\n')
  const cached = sdkClients.get(key)
  if (cached !== undefined) return cached
  const client = new SdkClient({
    credential: { secretId: target.secretId, secretKey: target.secretKey },
    region: target.region,
    profile: {
      httpProfile: {
        endpoint: target.endpoint,
        protocol: target.protocol === 'http' ? 'http:' : 'https:',
        reqTimeout: Math.ceil((target.requestTimeoutMs ?? 20000) / 1000),
      },
    },
  })
  sdkClients.set(key, client)
  return client
}

/** Drop cached clients so a credential change cannot reuse the old identity. */
export function resetSdkClients() {
  sdkClients.clear()
}

/** One action through the official SDK. */
async function callViaSdk(SdkClient, target, action, params) {
  const client = sdkClientFor(SdkClient, target)
  const invoke = client[action]
  if (typeof invoke !== 'function') {
    throw new AdpError(`官方 SDK 没有 ${action} 接口。`, { code: 'SdkActionMissing', action })
  }
  try {
    return await invoke.call(client, params)
  } catch (error) {
    // TencentCloudSDKError carries `.code` and `.message` from the API envelope.
    const code = error?.code ?? 'SdkError'
    throw new AdpError(
      describeApiError(`ADP ${action} 调用失败`, { Code: code, Message: error?.message ?? String(error) }),
      { code, action },
    )
  }
}

/** Signed call against an explicit endpoint; the shared transport for every action. */
async function signedCall(target, action, params, signal) {
  if (!target.secretId || !target.secretKey) {
    throw new AdpError(
      'Tencent Cloud credentials are missing: open the ADP 智能体 panel and save a SecretId / SecretKey pair, '
      + 'or set secretId / secretKey in this plugin’s config, or export TENCENTCLOUD_SECRET_ID and '
      + 'TENCENTCLOUD_SECRET_KEY.',
      { code: 'MissingCredentials', action },
    )
  }
  // The official SDK is product-specific: only the `adp` actions exist on it. The
  // identity probe (CVM) and any other product must use the built-in signer.
  const SdkClient = target.service === 'adp' && target.useSdk !== false
    ? await loadAdpSdk(true)
    : null
  if (SdkClient !== null) return callViaSdk(SdkClient, target, action, params)
  return callViaHttp(target, action, params, signal)
}

/** Signed call built on the plugin's own TC3 implementation (SDK-free fallback). */
async function callViaHttp(target, action, params, signal) {
  const timestamp = Math.floor(Date.now() / 1000)
  const { headers, body } = buildTc3Headers({
    secretId: target.secretId,
    secretKey: target.secretKey,
    endpoint: target.endpoint,
    service: target.service,
    action,
    version: target.apiVersion,
    region: target.region,
    payload: params,
    timestamp,
  })

  let response
  try {
    response = await fetch(`${target.protocol}://${target.endpoint}/`, {
      method: 'POST',
      headers,
      body,
      signal,
    })
  } catch (cause) {
    throw new AdpError(
      `${action} 无法连接 ${target.endpoint}：${cause.message}`,
      { code: 'NetworkFailure', action },
    )
  }

  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new AdpError(
      `${target.endpoint} ${action} 返回 HTTP ${response.status}，响应不是 JSON：${text.slice(0, 300)}`,
      { action },
    )
  }

  const payload = parsed && typeof parsed === 'object' ? parsed.Response : undefined
  if (!payload || typeof payload !== 'object') {
    throw new AdpError(
      `${target.endpoint} ${action} 返回了无法识别的结构：${text.slice(0, 300)}`,
      { action },
    )
  }
  if (payload.Error) {
    throw new AdpError(
      describeApiError(`ADP ${action} 调用失败`, payload.Error),
      { code: payload.Error.Code, requestId: payload.RequestId, action },
    )
  }
  return payload
}

/** Call one ADP action on the configured endpoint and return its `Response`. */
async function callAdp(credentials, action, params, signal) {
  return signedCall({
    secretId: credentials.secretId,
    secretKey: credentials.secretKey,
    endpoint: credentials.endpoint,
    protocol: credentials.protocol,
    apiVersion: credentials.apiVersion,
    region: credentials.region,
    service: 'adp',
    useSdk: credentials.useSdk,
    requestTimeoutMs: credentials.requestTimeoutMs,
  }, action, params, signal)
}

/**
 * The standard probe list, for the site currently in force.
 *
 * On the Tencent Cloud sites the first probe is CVM (a product every cloud account
 * has), so "nothing recognises the key" can be told apart from "ADP specifically
 * refuses it". A 独立站 key does not exist on Tencent Cloud at all, so the standalone
 * plan probes the three ADP endpoints instead and compares them.
 */
function defaultVerifyPlan(credentials) {
  const current = credentials.site ?? 'cn'
  const adpProbe = site => ({
    id: site,
    site,
    label: `${SITES[site].label} ADP 应用清单`,
    endpoint: SITES[site].endpoint,
    service: 'adp',
    action: 'DescribeAppSummaryList',
    apiVersion: credentials.apiVersion,
    params: { SpaceId: credentials.spaceId, PageNumber: 0, PageSize: 1 },
  })
  // The configured host wins over the site table so a local mock stays reachable.
  const currentProbe = { ...adpProbe(current), endpoint: credentials.endpoint }

  const others = PROBE_SITES.filter(site => site !== current).map(adpProbe)
  if (current === 'standalone') return [currentProbe, ...others]

  return [
    {
      id: 'identity',
      site: 'cn',
      label: '腾讯云身份核对（CVM 只读）',
      endpoint: 'cvm.tencentcloudapi.com',
      service: 'cvm',
      action: 'DescribeRegions',
      apiVersion: '2017-03-12',
      params: {},
    },
    currentProbe,
    ...others,
  ]
}

/**
 * Probe the key pair against several endpoints so a failure can be attributed.
 * The first probe is a product the account almost certainly has (CVM read-only):
 * if it fails too, the key itself is the problem and ADP is not implicated.
 * @param credentials - effective credentials.
 * @param signal - cancellation.
 * @param plan - probe list override, used by tests to stay offline.
 */
export async function verifyCredentials(credentials, signal, plan = defaultVerifyPlan(credentials)) {
  const base = {
    secretId: credentials.secretId,
    secretKey: credentials.secretKey,
    protocol: credentials.protocol,
    region: credentials.region,
  }

  const checks = []
  for (const step of plan) {
    try {
      const payload = await signedCall({ ...base, ...step }, step.action, step.params, signal)
      checks.push({
        id: step.id,
        site: step.site,
        label: step.label,
        endpoint: step.endpoint,
        ok: true,
        code: null,
        message: step.service === 'cvm'
          ? '密钥有效。'
          : `接口可用，返回 ${Array.isArray(payload.AppSummaryList) ? payload.AppSummaryList.length : 0} 条应用。`,
      })
    } catch (error) {
      checks.push({
        id: step.id,
        site: step.site,
        label: step.label,
        endpoint: step.endpoint,
        ok: false,
        code: error instanceof AdpError ? error.code ?? null : null,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const current = credentials.site ?? 'cn'
  const currentCheck = checks.find(check => check.id === current)
  const otherSiteOk = checks.some(check => check.site !== undefined && check.site !== current && check.ok)
  const identity = checks.find(check => check.id === 'identity')
  let verdict
  if (currentCheck?.ok === true) verdict = 'ok'
  // The same key reaching another site's ADP means it is real but enrolled elsewhere.
  else if (otherSiteOk) verdict = 'wrong-site'
  // Nothing recognises it — including CVM, a product every cloud account has.
  else if (identity === undefined || identity.ok === false) verdict = 'bad-key'
  else verdict = 'adp-permission'

  return {
    verdict,
    site: current,
    currentSiteFailed: currentCheck?.ok === false ? currentCheck : null,
    checks,
  }
}

/**
 * Mint a one-shot Socket.IO handshake token for an API conversation.
 * `Type: 5` (API 接入) requires the app's AppKey; the returned token is the only place
 * the conversation channel receives the app identity.
 * https://cloud.tencent.com/document/product/1759/132522
 */
async function createWebSocketToken(credentials, appId, appKey, userId, signal) {
  const response = await callAdp(credentials, 'CreateWebSocketToken', {
    Type: 5,
    AppId: appId,
    AppKey: appKey,
    UserId: userId,
  }, signal)
  const token = response.Token
  if (typeof token !== 'string' || token === '') {
    throw new AdpError('CreateWebSocketToken 没有返回 Token。', { code: 'WebSocketTokenUnavailable' })
  }
  return token
}

/**
 * Run one chat turn, choosing the transport.
 *
 * `auto` prefers the documented SSE endpoint and falls back to the Socket.IO channel
 * only when the SSE service cannot resolve the app — the failure mode observed on the
 * 独立站, where the management API accepts the same AppKey.
 *
 * `options.sse` / `options.ws` exist so the fallback policy itself is unit-testable.
 */
export async function runAdpChat(options) {
  const transport = options.transport ?? 'auto'
  const runSse = options.sse ?? (() => streamAdpChat(options))
  const runWs = options.ws ?? (async () => {
    const token = await options.openWebSocketToken()
    return streamAdpChatWs({ ...options, token })
  })
  if (transport === 'sse') return runSse()
  if (transport === 'ws') return runWs()

  try {
    return await runSse()
  } catch (error) {
    // `460004`/`460033` mean the SSE service has no bot for this app; `460048` means the
    // app is simply unpublished, which the WS channel cannot fix either.
    if (isAppUnpublished(error) || !isAppUnresolved(error)) throw error
    return runWs()
  }
}

/** List the spaces this key can see, so a caller can pick a real `SpaceId`. */async function listSpaces(credentials, signal) {
  const response = await callAdp(credentials, 'DescribeSpaceList', { Query: '' }, signal)
  const spaces = Array.isArray(response.SpaceList) ? response.SpaceList : []
  return spaces.map(space => ({
    spaceId: String(space?.SpaceId ?? ''),
    name: space?.Name ?? '',
    description: space?.Description ?? '',
  })).filter(space => space.spaceId !== '')
}

/**
 * Open an API-access conversation and return its `ConversationId`.
 *
 * This is the documented prerequisite for the conversation stream, and the step it is
 * easy to miss: the conversation must carry the app's AppKey, or the chat backend has
 * no application bound to it and answers `460004 应用不存在`.
 * `Type: 5` is the 枚举值 meaning 「API 接入」.
 * https://cloud.tencent.com/document/product/1759/133869 (步骤 6：创建会话)
 */
async function createApiConversation(credentials, appId, appKey, userId, signal) {
  const response = await callAdp(credentials, 'CreateConversation', {
    Type: 5,
    AppId: appId,
    AppKey: appKey,
    UserId: userId,
  }, signal)
  const conversationId = response.ConversationId
  if (typeof conversationId !== 'string' || conversationId === '') {
    throw new AdpError('CreateConversation 没有返回 ConversationId。', { code: 'ConversationNotCreated' })
  }
  return conversationId
}

/** List apps with paging, fuzzy query and an optional status filter. */
async function listApps(credentials, options, signal) {
  const params = {
    SpaceId: credentials.spaceId,
    PageNumber: options.pageNumber ?? 0,
    PageSize: options.pageSize ?? 50,
  }
  if (options.query) params.Query = options.query
  if (options.statusList && options.statusList.length > 0) {
    params.FilterList = [{ Name: 'AppStatus', ValueList: options.statusList.map(String) }]
  }
  const response = await callAdp(credentials, 'DescribeAppSummaryList', params, signal)
  return {
    apps: Array.isArray(response.AppSummaryList) ? response.AppSummaryList : [],
    total: typeof response.TotalCount === 'number' ? response.TotalCount : 0,
  }
}

/** Read the app detail, optionally restricted by a field mask. */
async function describeApp(credentials, appId, paths, signal) {
  const params = { AppId: appId }
  if (paths && paths.length > 0) params.FieldMask = { Paths: paths }
  const response = await callAdp(credentials, 'DescribeApp', params, signal)
  return response.App ?? null
}

/** Depth-first search for the first non-empty `AppKey`-like string in a value. */
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

/**
 * Resolve the AppKey the conversation API needs.
 * The production domain (2) is the one whose release serves `wss.lke.cloud.tencent.com`.
 */
async function resolveAppKey(credentials, appId, signal) {
  const app = await describeApp(credentials, appId, ['SecretInfo'], signal)
  const appKey = findAppKey(app)
  if (appKey === undefined) {
    throw new AdpError(
      `ADP returned no AppKey for app ${appId}. The app has no successful release yet — `
      + 'publish it first (CreateRelease), then retry.',
      { code: 'AppKeyUnavailable' },
    )
  }
  return appKey
}

/** Start a release task for an app. */
async function createRelease(credentials, appId, description, signal) {
  return callAdp(credentials, 'CreateRelease', {
    AppId: appId,
    ...(description ? { Description: description } : {}),
  }, signal)
}

/** Read the newest release summary for an app. */
async function describeLatestRelease(credentials, appId, signal) {
  const response = await callAdp(credentials, 'DescribeLatestRelease', { AppId: appId }, signal)
  return { release: response.ReleaseSummary ?? null, isChanged: response.IsChanged === true }
}

/**
 * Start a release and wait until it settles.
 * `Write`/`CreateRelease` returns a task id; the task's own status is polled through
 * `DescribeLatestRelease` because ADP exposes no per-task query by release id.
 */
/**
 * Read one release task by id.
 * The walkthrough polls the exact task with `DescribeReleaseSummary`, which is more
 * precise than the app's newest release:
 * https://cloud.tencent.com/document/product/1759/133869 (步骤 5：发布应用)
 */
async function describeReleaseSummary(credentials, appId, releaseId, signal) {
  const response = await callAdp(credentials, 'DescribeReleaseSummary', {
    AppId: appId,
    ReleaseId: releaseId,
  }, signal)
  return response.ReleaseSummary ?? null
}

async function publishApp(credentials, appId, options, signal) {
  const created = await createRelease(credentials, appId, options.description, signal)
  if (created.NeedApproval === true) {
    return {
      appId,
      releaseId: created.ReleaseId,
      status: 'pending-approval',
      statusDescription: '发布任务已创建，等待管理员审批。',
    }
  }
  const deadline = Date.now() + options.releaseTimeoutMs
  let pollViaSummary = true
  while (Date.now() < deadline) {
    let release = null
    if (pollViaSummary) {
      try {
        release = await describeReleaseSummary(credentials, appId, created.ReleaseId, signal)
      } catch (error) {
        // An older deployment may not serve this action; fall back for later polls.
        if (error?.code === 'InvalidAction' || error?.code === 'SdkActionMissing') pollViaSummary = false
        else throw error
      }
    }
    if (release === null) release = (await describeLatestRelease(credentials, appId, signal)).release
    if (release && String(release.ReleaseId) === String(created.ReleaseId) && typeof release.Status === 'number') {
      const known = RELEASE_STATUS[release.Status]
      if (known === undefined || known.terminal) {
        const failed = release.Status !== 3 && release.Status !== 6 && release.Status !== 11
        return {
          appId,
          releaseId: created.ReleaseId,
          status: known?.key ?? `status-${release.Status}`,
          succeeded: !failed,
          statusDescription: release.StatusDescription || known?.zh || '',
        }
      }
    }
    await sleep(1500, signal)
  }
  return {
    appId,
    releaseId: created.ReleaseId,
    status: 'timeout',
    statusDescription: `发布任务已提交（ReleaseId=${created.ReleaseId}），在 ${options.releaseTimeoutMs}ms 内未观察到终态。`,
  }
}

/** Abortable sleep. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/* ------------------------------------------------------------------ *
 * ADP conversation (HTTP SSE)
 * ------------------------------------------------------------------ */

/** Random id in the 32-64 char `^[a-zA-Z0-9_-]{32,64}$` shape the API demands. */
function newRequestId() {
  return randomUUID().replace(/-/g, '')
}
/** Conversation ids share the request-id grammar. */
function newConversationId() {
  return randomUUID().replace(/-/g, '')
}

/**
 * Incremental text of a `text.delta` / `text.replace` frame.
 * Wire shape: `{"Type":"text.delta","MessageId":"rpl_…","Text":"…"}`.
 */
function extractDeltaText(payload) {
  if (payload === null || typeof payload !== 'object') return ''
  if (typeof payload.Text === 'string') return payload.Text
  if (typeof payload.text === 'string') return payload.text
  return ''
}

/**
 * Authoritative text of a completion frame (`message.done` / `response.completed`).
 * These carry the whole message, so they must never be appended to the deltas:
 * `message.done` holds `Message.Contents[]`, `response.completed` holds `Response.Messages[]`.
 * Any message the stream already labelled `thought` is excluded.
 */
/**
 * Pull the human-in-the-loop pieces out of a final record.
 *
 * A Claw agent asks for input through the `AskUserQuestion` tool, and the platform
 * delivers the answerable form as a reply whose `Contents` is a `questionnaire` — with
 * **no text at all**. Rendering only text therefore loses the question entirely.
 * `file` contents (produced artifacts) are collected the same way.
 * @param record - a `message.done` message, or a `response.completed` response.
 * @returns normalised interaction descriptors, in message order.
 */
function extractInteractions(record) {
  if (record === null || typeof record !== 'object') return []
  const messages = Array.isArray(record.Messages) ? record.Messages : [record]
  const out = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.Type === 'thought') continue
    if (!Array.isArray(message.Contents)) continue
    for (const content of message.Contents) {
      if (content === null || typeof content !== 'object') continue
      if (content.Type === 'questionnaire' && content.Questionnaire) {
        const form = content.Questionnaire
        const questions = (Array.isArray(form.Questions) ? form.Questions : []).map((question) => ({
          index: question.Index ?? 0,
          question: question.Question ?? '',
          required: question.Required === true,
          multiSelect: question.MultiSelect === true || question.Type === 2,
          options: (Array.isArray(question.Options) ? question.Options : []).map(option => ({
            label: option.Label ?? '',
            description: option.Description ?? '',
          })),
        }))
        if (questions.length > 0) {
          out.push({ kind: 'questionnaire', title: form.Title ?? '', questions })
        }
      } else if (content.Type === 'file') {
        out.push({
          kind: 'file',
          name: content.FileName ?? content.Name ?? '',
          url: content.FileUrl ?? content.Url ?? '',
        })
      }
    }
  }
  return out
}

/** The event's own name, from the SSE `event:` line or the payload's type field. */
function eventName(sseEvent, payload) {
  if (sseEvent) return sseEvent
  if (payload && typeof payload === 'object') {
    for (const key of ['Type', 'type', 'Event', 'event']) {
      if (typeof payload[key] === 'string') return payload[key]
    }
  }
  return ''
}

/** Human-readable message from an ADP error event payload. */
function eventError(payload) {
  if (!payload || typeof payload !== 'object') return '会话接口返回了未知错误。'
  const error = payload.Error ?? payload.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const code = error.Code ?? error.code ?? ''
    const message = error.Message ?? error.message ?? ''
    return [code, message].filter(Boolean).join(' — ') || '会话接口返回了未识别的错误。'
  }
  return payload.Message ?? payload.message ?? '会话接口返回了未识别的错误。'
}

/**
 * The message kind of a `message.added` frame.
 * The wire carries it as `Message.Type` (`thought` / `reply`); some captures also put a
 * `MessageType` at the top level.
 */
function addedMessageKind(payload) {
  const kind = payload?.Message?.Type ?? payload?.MessageType
  return typeof kind === 'string' ? kind : undefined
}

/**
 * Fold ADP conversation events into one answer.
 *
 * Both transports (HTTP SSE and Socket.IO) deliver the same event vocabulary, so the
 * reduction lives here once. `push(name, payload)` returns the incremental text that
 * should be shown, and `result()` yields the aggregated answer.
 */
function createChatReducer(onEvent) {
  /** MessageId → the kind declared by `message.added`. */
  const kinds = new Map()
  /**
   * The turn as an ordered timeline, not one blob.
   *
   * The ADP protocol narrates a turn as a sequence of messages: a `thought`, a `reply`,
   * a `tool_call` (with `message.processing` while it runs and a `text.replace` carrying
   * its output), then the next `thought`/`reply` pair. Discarding the non-reply messages
   * left the panel blank for many seconds while the agent worked, so every message keeps
   * its own entry and each is streamed as it happens.
   */
  const entries = new Map()
  let order = []
  let failure = null
  /** Structured, non-text content from the authoritative final record. */
  let interactions = []

  const keyOf = (payload) => {
    const id = payload?.MessageId
    return typeof id === 'string' && id !== '' ? id : `anon-${order.length}`
  }
  const kindOfMessage = (message) => {
    const type = message?.Type
    if (type === 'thought') return 'reasoning'
    if (type === 'reply') return 'answer'
    if (type === 'tool_call') return 'tool'
    if (type === 'task' || type === 'question') return 'task'
    return 'notice'
  }
  const upsert = (id, patch) => {
    let entry = entries.get(id)
    if (entry === undefined) {
      entry = { id, kind: 'notice', name: '', title: '', tool: '', status: 'running', text: '', files: [] }
      entries.set(id, entry)
      order.push(id)
    }
    Object.assign(entry, patch)
    return entry
  }
  const timeline = () => order.map(id => entries.get(id)).filter(entry => entry !== undefined)

  const push = (name, payload) => {
    const isError = name === 'error' || name.endsWith('.error')
      || (payload !== null && typeof payload === 'object' && payload.Error !== undefined)
    if (isError) {
      failure = eventError(payload)
      onEvent?.(name, payload, '', null)
      return { text: '', failure }
    }

    /** Flat answer text for this frame; the completion frame also carries the whole answer. */
    let text = ''
    /** Timeline patch for the panel, or null when this frame changes nothing visible. */
    let patch = null

    if (name === 'message.added') {
      const id = keyOf(payload)
      const message = payload?.Message
      // `kinds` keeps the raw ADP type (the delta branch filters on `thought`/`reply`);
      // entries and patches always carry the normalised kind the panel switches on.
      const rawKind = addedMessageKind(payload)
      if (typeof payload?.MessageId === 'string' && rawKind !== undefined) kinds.set(payload.MessageId, rawKind)
      const entry = upsert(id, {
        kind: kindOfMessage(message),
        name: message?.Name ?? '',
        title: message?.Title ?? '',
        tool: message?.ExtraInfo?.ToolName ?? '',
        status: 'running',
      })
      patch = { id, kind: entry.kind, name: entry.name, title: entry.title, tool: entry.tool, status: 'running' }
    } else if (name === 'message.processing') {
      // `Title` here is the concrete invocation: the command line, the target file.
      const id = keyOf(payload)
      const message = payload?.Message
      const entry = upsert(id, {
        kind: kindOfMessage(message),
        // `Title` on a processing frame is the concrete invocation.
        title: message?.Title || '',
        tool: message?.ExtraInfo?.ToolName ?? '',
        status: 'running',
      })
      patch = { id, kind: entry.kind, name: entry.name, title: entry.title, tool: entry.tool, status: 'running' }
    } else if (name === 'content.added') {
      const content = payload?.Content
      if (content?.Type === 'file') {
        const id = keyOf(payload)
        const entry = upsert(id, {})
        const file = { name: content.FileName ?? content.Name ?? '', url: content.FileUrl ?? content.Url ?? '' }
        if (!entry.files.some(existing => existing.url === file.url)) entry.files.push(file)
        patch = { id, files: entry.files }
      }
    } else if (name === 'text.delta' || name === 'text.replace') {
      const id = keyOf(payload)
      const kind = kinds.get(payload?.MessageId)
      const chunk = extractDeltaText(payload)
      const reasonKind = kind === 'thought' ? 'reasoning' : kind === 'tool_call' ? 'tool' : null
      if (reasonKind !== null) {
        const entry = upsert(id, { kind: reasonKind })
        if (name === 'text.replace') entry.text = chunk
        else entry.text += chunk
        // Reasoning is rendered collapsed and can reach tens of KB, so only its head is
        // streamed; tool output is kept whole because it is short and worth reading.
        if (reasonKind === 'reasoning') {
          if (name === 'text.replace') {
            patch = { id, text: chunk.slice(0, REASONING_LIMIT) }
          } else if (entry.text.length <= REASONING_LIMIT) {
            patch = { id, append: chunk }
          }
        } else {
          patch = name === 'text.replace' ? { id, text: chunk } : { id, append: chunk }
        }
      } else if (kind === undefined || kind === 'reply') {
        // `message.added` already created the entry, so "first text for this message" is
        // what starts a paragraph — not "entry missing".
        const isNewAnswer = (entries.get(id)?.text ?? '') === ''
        const entry = upsert(id, { kind: 'answer' })
        if (name === 'text.replace') entry.text = chunk
        else entry.text += chunk
        // One turn narrates through several `reply` messages. The timeline keeps them as
        // separate entries, and the flat stream keeps a blank line between them so both
        // representations of the turn agree.
        const separator = isNewAnswer && timeline().some(other => other.kind === 'answer' && other.id !== id && other.text !== '')
          ? '\n\n'
          : ''
        text = separator + chunk
        patch = name === 'text.replace'
          ? { id, kind: 'answer', text: chunk }
          : { id, kind: 'answer', append: chunk }
      }
    } else if (name === 'message.done') {
      const id = keyOf(payload)
      const message = payload?.Message
      const entry = upsert(id, { status: 'done' })
      if (typeof message?.Title === 'string' && message.Title !== '') entry.title = message.Title
      patch = { id, status: 'done', title: entry.title }
      const found = extractInteractions(payload?.Message)
      if (found.length > 0) interactions = found
    } else if (name === 'response.completed') {
      // The completed response restates every message, so it is authoritative: rebuild
      // the timeline from it instead of trusting the incremental stream.
      const rebuilt = rebuildTimeline(payload?.Response)
      if (rebuilt.order.length > 0) {
        // Copy first: `entries.clear()` would otherwise empty the very map we read from.
        const previous = new Map(entries)
        entries.clear()
        order = [...rebuilt.order]
        for (const [id, entry] of rebuilt.entries) {
          const before = previous.get(id)
          if (before !== undefined) {
            // The completed record restates structure and final state, but the concrete
            // invocation and live output exist only on the incremental frames.
            if (entry.title === '') entry.title = before.title
            if (entry.text === '') entry.text = before.text
            if (entry.files.length === 0) entry.files = before.files
            if (entry.tool === '') entry.tool = before.tool
          }
          entries.set(id, entry)
        }
        for (const id of order) {
          const entry = entries.get(id)
          onEvent?.(`entry.${entry.kind}`, payload, '', { ...entry, replace: true })
        }
      }
      const found = extractInteractions(payload?.Response)
      if (found.length > 0) interactions = found
    }

    onEvent?.(name, payload, text, patch)
    return { text, failure }
  }

  const answerText = () => timeline()
    .filter(entry => entry.kind === 'answer')
    .map(entry => entry.text)
    .filter(value => value !== '')
    .join('\n\n')

  return {
    push,
    failure: () => failure,
    /** Every visible part of the turn, in protocol order. */
    timeline,
    /** The answer alone, which is what the completion frame reports. */
    result: answerText,
    /** Questionnaires and files carried by the turn. */
    interactions: () => interactions,
  }
}

/** Reasoning can be tens of KB per step; the panel shows it collapsed. */
const REASONING_LIMIT = 4000

/** Rebuild the whole timeline from a `response.completed` payload. */
function rebuildTimeline(record) {
  const entries = new Map()
  const order = []
  if (record === null || typeof record !== 'object') return { entries, order }
  const messages = Array.isArray(record.Messages) ? record.Messages : [record]
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    let kind = 'notice'
    if (message.Type === 'thought') kind = 'reasoning'
    else if (message.Type === 'reply') kind = 'answer'
    else if (message.Type === 'tool_call') kind = 'tool'
    else if (message.Type === 'task' || message.Type === 'question') kind = 'task'
    let text = ''
    const files = []
    for (const content of Array.isArray(message.Contents) ? message.Contents : []) {
      if (content === null || typeof content !== 'object') continue
      if (content.Type === 'text' && typeof content.Text === 'string') text += content.Text
      // On a tool message the `json_text` content is the tool's own output; on a reply it
      // is internal chatter and must not reach the prose.
      if (kind === 'tool' && content.Type === 'json_text' && typeof content.Text === 'string') text += content.Text
      if (content.Type === 'file') {
        files.push({ name: content.FileName ?? content.Name ?? '', url: content.FileUrl ?? content.Url ?? '' })
      }
    }
    if (kind === 'reasoning') text = text.slice(0, REASONING_LIMIT)
    if (text === '' && files.length === 0 && kind === 'notice') continue
    const id = typeof message.MessageId === 'string' && message.MessageId !== ''
      ? message.MessageId
      : `#${order.length}`
    entries.set(id, {
      id,
      kind,
      name: message.Name ?? '',
      // Never fall back to `Name`: the concrete invocation would be lost when the
      // completion frame restates the message.
      title: message.Title ?? '',
      tool: message.ExtraInfo?.ToolName ?? '',
      status: 'done',
      text,
      files,
    })
    order.push(id)
  }
  return { entries, order }
}

/** A short, human-readable label for the panel's event list. */
function eventLabel(name, payload) {
  const message = payload?.Message
  const title = typeof message?.Title === 'string' ? message.Title : ''
  if (title !== '') return `${name} · ${title.slice(0, 80)}`
  const tool = message?.ExtraInfo?.ToolName
  if (typeof tool === 'string' && tool !== '') return `${name} · ${tool}`
  return name
}

/** Whether an error means the conversation service cannot resolve the app. */
function isAppUnresolved(error) {
  const text = error instanceof Error ? error.message : String(error)
  return /460004|460033|机器人不存在|应用不存在/.test(text)
}

/** Whether an error means the app has no published version yet. */
function isAppUnpublished(error) {
  const text = error instanceof Error ? error.message : String(error)
  return /460048|应用未发布/.test(text)
}

/**
 * Stream a chat turn over the HTTP SSE endpoint.
 * @param options - credentials, request fields and the per-event sink.
 * @returns the aggregated assistant text for non-streaming callers.
 */
export async function streamAdpChat(options) {
  const { endpoint, appKey, message, userId, userName, signal, onEvent } = options
  const conversationId = await resolveConversationId(options)
  const body = {
    RequestId: newRequestId(),
    ConversationId: conversationId,
    AppKey: appKey,
    VisitorId: userId,
    UserId: userId,
    Contents: [{ Type: 'text', Text: message }],
    Stream: 'enable',
    Incremental: true,
    EnableMultiIntent: true,
  }
  if (userName) body.UserName = userName

  // The SSE stream can also go quiet; abort the request instead of hanging forever.
  const idleTimeoutMs = options.idleTimeoutMs ?? 90000
  const controller = new AbortController()
  let stalled = false
  let idleTimer = setTimeout(() => { stalled = true; controller.abort() }, idleTimeoutMs)
  const bump = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { stalled = true; controller.abort() }, idleTimeoutMs)
  }
  signal?.addEventListener('abort', () => controller.abort(), { once: true })

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new AdpError(
      `ADP 会话接口返回 HTTP ${response.status}: ${detail.slice(0, 300)}`,
      { code: 'ChatHttpError' },
    )
  }
  if (!response.body) throw new AdpError('ADP 会话接口没有返回响应流。', { code: 'ChatNoBody' })

  const decoder = new TextDecoder('utf-8')
  const reducer = createChatReducer(onEvent)
  let buffer = ''
  try {
    for await (const chunk of response.body) {
      bump()
      buffer += decoder.decode(chunk, { stream: true })
      let boundary = findEventBoundary(buffer)
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2))
        dispatchSseBlock(raw, (name, payload) => { reducer.push(name, payload) })
        boundary = findEventBoundary(buffer)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim() !== '') dispatchSseBlock(buffer, (name, payload) => { reducer.push(name, payload) })
  } catch (error) {
    if (!stalled) throw error
    const failure = new AdpError(
      `SSE 会话已 ${Math.round(idleTimeoutMs / 1000)} 秒没有收到任何数据。`,
      { code: 'ChatStalled' },
    )
    if (reducer.result() !== '') failure.partialText = reducer.result()
    throw failure
  } finally {
    clearTimeout(idleTimer)
  }

  if (reducer.failure() !== null) throw new AdpError(reducer.failure(), { code: 'ChatEventError' })
  return {
    text: reducer.result(),
    requestId: body.RequestId,
    conversationId,
    transport: 'sse',
    complete: true,
    interactions: reducer.interactions(),
    timeline: reducer.timeline(),
  }
}

/**
 * Stream a chat turn over the documented Socket.IO channel.
 *
 * The WS channel is the working path on the 独立站: the SSE endpoint answers
 * `460004 机器人不存在` for an app the management API accepts, while the WS path
 * carries the app identity in a minted token and answers normally.
 * https://cloud.tencent.com/document/product/1759/129365
 */
export async function streamAdpChatWs(options) {
  const { wsEndpoint, token, message, userId, signal, onEvent } = options
  const conversationId = await resolveConversationId(options)
  if (typeof WebSocket !== 'function') {
    throw new AdpError('当前 Node 运行时不提供 WebSocket，无法使用 ws 会话通道。', { code: 'WebSocketUnavailable' })
  }

  const url = new URL(wsEndpoint)
  url.searchParams.set('language', url.searchParams.get('language') ?? 'zh-CN')
  url.searchParams.set('EIO', '4')
  url.searchParams.set('transport', 'websocket')

  const socket = new WebSocket(url.toString())
  const reducer = createChatReducer(onEvent)
  let settled = false
  // A Claw-mode turn can legitimately run for minutes, so the guard is *liveness*, not
  // wall-clock: the server pings every 25s, so any received frame proves the connection
  // is alive and the agent is simply still working.
  const idleTimeoutMs = options.idleTimeoutMs ?? 90000
  const totalTimeoutMs = options.timeoutMs ?? 900000

  const outcome = await new Promise((resolve) => {
    let opened = false
    let completed = false
    let idleTimer
    let totalTimer
    const done = (error) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      try { socket.close() } catch { /* already closing */ }
      resolve(error === undefined ? { completed } : { error, partial: reducer.result() })
    }
    /** Every inbound frame — including a heartbeat — resets the stall guard. */
    const alive = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(
        () => done(new AdpError(
          `WS 会话已 ${Math.round(idleTimeoutMs / 1000)} 秒没有任何帧（含心跳），连接可能已失效。`,
          { code: 'ChatStalled' },
        )),
        idleTimeoutMs,
      )
    }
    totalTimer = setTimeout(
      () => done(new AdpError(
        `WS 会话超过 ${Math.round(totalTimeoutMs / 1000)} 秒仍未结束。`,
        { code: 'ChatTimeout' },
      )),
      totalTimeoutMs,
    )
    alive()
    const abort = () => done(new AdpError('WS 会话已取消。', { code: 'ChatAborted' }))
    signal?.addEventListener('abort', abort, { once: true })

    socket.addEventListener('open', () => { opened = true })
    socket.addEventListener('error', () => done(new AdpError(`无法连接 WS 会话端点 ${url.host}。`, { code: 'ChatWsError' })))
    socket.addEventListener('close', (event) => {
      if (!opened) {
        done(new AdpError(`WS 会话端点 ${url.host} 在握手阶段断开。`, { code: 'ChatWsClosed' }))
        return
      }
      // A close before `response.completed` is a real failure, not a silent success:
      // keep whatever text arrived so the caller can still show it.
      done(completed
        ? undefined
        : new AdpError(
          `WS 连接在回复完成前被关闭（code=${event?.code ?? '?'}）。`,
          { code: 'ChatWsClosed' },
        ))
    })
    socket.addEventListener('message', (event) => {
      const frame = typeof event.data === 'string' ? event.data : ''
      if (frame === '') return
      alive()
      // Engine.IO open → authenticate with the Socket.IO connect packet.
      if (frame.startsWith('0')) {
        socket.send(`40${JSON.stringify({ token })}`)
        return
      }
      // Engine.IO heartbeat; the connection is dropped without a reply.
      if (frame === '2') {
        socket.send('3')
        return
      }
      // Engine.IO close / Socket.IO disconnect: fail now instead of waiting out a timer.
      if (frame === '1' || frame === '41') {
        done(completed ? undefined : new AdpError('WS 连接被服务端断开。', { code: 'ChatWsClosed' }))
        return
      }
      // Socket.IO connect error (`44{...}`) — e.g. a rejected or expired handshake token.
      if (frame.startsWith('44')) {
        let detail = frame.slice(2)
        try {
          const parsed = JSON.parse(detail)
          detail = parsed?.message ?? parsed?.data ?? detail
        } catch { /* keep the raw text */ }
        done(new AdpError(`WS 握手被拒：${detail}`, { code: 'ChatConnectError' }))
        return
      }
      if (frame.startsWith('40')) {
        socket.send(`42${JSON.stringify(['request', {
          Type: 'request',
          Request: {
            RequestId: newRequestId(),
            ConversationId: conversationId,
            Contents: [{ Type: 'text', Text: message }],
            Incremental: true,
            EnableMultiIntent: true,
            Stream: 'enable',
          },
        }])}`)
        return
      }
      if (!frame.startsWith('42')) return
      let parsed
      try {
        parsed = JSON.parse(frame.slice(2))
      } catch {
        return
      }
      // `42["event",{...}]`; the payload carries the same `Type` as the SSE frames.
      const payload = Array.isArray(parsed) ? parsed[1] : parsed
      if (payload === null || typeof payload !== 'object') return
      const { failure } = reducer.push(payload.Type ?? '', payload)
      if (failure !== null) {
        done(new AdpError(failure, { code: 'ChatEventError' }))
        return
      }
      if (payload.Type === 'response.completed') {
        completed = true
        done(undefined)
      }
    })
  })

  if (outcome.error !== undefined) {
    if (reducer.failure() !== null) throw new AdpError(reducer.failure(), { code: 'ChatEventError' })
    // A partial answer is still worth reporting, so it rides along with the failure.
    if (outcome.partial !== '') {
      outcome.error.partialText = outcome.partial
      outcome.error.conversationId = conversationId
    }
    throw outcome.error
  }
  return {
    text: reducer.result(),
    conversationId,
    transport: 'ws',
    complete: true,
    interactions: reducer.interactions(),
    timeline: reducer.timeline(),
  }
}

/** Resolve the conversation id, opening one through the management API when absent. */
async function resolveConversationId(options) {
  const conversationId = options.conversationId ?? (options.openConversation === undefined
    ? undefined
    : await options.openConversation())
  if (conversationId === undefined) {
    throw new AdpError('会话接口需要 ConversationId，且未提供创建方式。', { code: 'ConversationRequired' })
  }
  return conversationId
}

/** Index of the next `\n\n` / `\r\n\r\n` separator, or -1. */
function findEventBoundary(buffer) {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf < 0) return crlf
  if (crlf < 0) return lf
  return Math.min(lf, crlf)
}

/** Decode one SSE block (its `event:` and `data:` lines) and hand it to `emit`. */
function dispatchSseBlock(raw, emit) {
  let name = ''
  const dataLines = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0 && name === '') return
  const data = dataLines.join('\n')
  let payload = data
  if (data !== '') {
    try {
      payload = JSON.parse(data)
    } catch {
      payload = data
    }
  }
  emit(eventName(name, payload), payload)
}

/* ------------------------------------------------------------------ *
 * The DSH-callability gate
 * ------------------------------------------------------------------ */

/** Resolve where the gate and credentials live. */
function resolveStatePath(settings) {
  if (settings.statePath) return settings.statePath
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'adp-console', 'state.json')
}

/** Load persisted state, tolerating a missing or corrupt file. */
async function loadState(path) {
  const empty = { enabledAppIds: new Set(), credentials: {} }
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    const enabled = Array.isArray(parsed?.enabledAppIds)
      ? parsed.enabledAppIds.filter(id => typeof id === 'string')
      : []
    const stored = parsed?.credentials
    const credentials = {}
    if (stored !== null && typeof stored === 'object') {
      for (const field of ['secretId', 'secretKey', 'region', 'spaceId', 'site']) {
        if (typeof stored[field] === 'string' && stored[field] !== '') credentials[field] = stored[field]
      }
    }
    return { enabledAppIds: new Set(enabled), credentials }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error(`[adp-console] ignoring unreadable state at ${path}: ${error.message}`)
    }
    return empty
  }
}

/**
 * Persist the gate and credentials atomically, readable only by the owner.
 * The file holds a Tencent Cloud SecretKey in plaintext, so its mode matters.
 */
async function saveState(path, state) {
  const payload = JSON.stringify({
    version: 2,
    enabledAppIds: [...state.enabledAppIds].sort(),
    credentials: state.credentials,
    updatedAt: new Date().toISOString(),
  }, null, 2)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  // `writeFile`'s mode applies only on creation; a pre-existing file keeps its own.
  await chmod(path, 0o600).catch(() => {})
}

/** Show only the ends of a secret so the panel can confirm which key is in use. */
function maskSecret(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}****${value.slice(-4)}`
}

/** Host of a URL, or the raw value when it does not parse; never throws. */
function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url ?? '')
  }
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Whether a host authority names the local machine. */
function isLoopbackAuthority(authority) {
  if (typeof authority !== 'string' || authority === '') return false
  const hostname = authority.startsWith('[')
    ? authority.slice(1, authority.indexOf(']'))
    : authority.split(':')[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/** Read and JSON-parse a request body with a size cap. */
async function readJsonBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** Project one ADP `AppSummary` plus local gate state onto the wire shape. */
function projectApp(summary, enabled, release) {
  const status = summary?.Status?.Status
  return {
    appId: String(summary?.AppId ?? ''),
    name: summary?.Name ?? '',
    avatar: summary?.Avatar ?? '',
    appMode: summary?.AppMode ?? null,
    appModeLabel: APP_MODE_LABEL[summary?.AppMode] ?? null,
    adpStatus: status ?? null,
    adpStatusLabel: APP_STATUS_LABEL[status] ?? null,
    adpStatusDescription: summary?.Status?.StatusDescription ?? '',
    creator: summary?.OperationInfo?.Creator ?? '',
    updateTime: summary?.OperationInfo?.UpdateTime ?? '',
    dshEnabled: enabled,
    releaseId: release?.ReleaseId ?? null,
    releaseStatus: typeof release?.Status === 'number' ? release.Status : null,
    releaseStatusDescription: release?.StatusDescription ?? '',
  }
}

/* ------------------------------------------------------------------ *
 * `@` mention bridge
 * ------------------------------------------------------------------ */

/**
 * The `@` token that releases the session back to the model.
 *
 * The exit is a pick like any other, so leaving ADP mode is one message the user
 * writes on purpose rather than an implicit boundary the plugin guesses at.
 */
export const MENTION_EXIT_TOKEN = 'DSH'

/** Sent when the message was nothing but the mention — an app still needs a first turn. */
export const MENTION_OPENING = '你好'

/**
 * The single word a pick inserts after `@`.
 *
 * The prompt is the only durable trace of a pick, and the Chat view decorates a
 * whitespace-bounded `@token`, so the token must be one word: whitespace becomes `-`
 * and anything else the token grammar cannot carry is dropped. The app name is a
 * display label, never an identity — the id rides the pick, not the prompt.
 * @param name - the app's display name.
 * @param appId - fallback when the name leaves no usable token.
 * @returns the token without its leading `@`.
 */
export function mentionToken(name, appId = '') {
  const cleaned = String(name ?? '')
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{N}_.-]/gu, '')
    .replace(/^-+|-+$/gu, '')
  if (cleaned !== '') return cleaned
  const fallback = String(appId ?? '').replace(/[^\p{L}\p{N}_.-]/gu, '')
  return fallback !== '' ? fallback : 'adp'
}

/** Sentence punctuation a typed `@token` may carry without being part of the token. */
const MENTION_TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、]+$/u

/**
 * Every whitespace-bounded `@token` of one text, in occurrence order.
 *
 * The shape matches the Chat view's own decoration rule, so what the user sees as a
 * mention is exactly what resolution considers.
 * @param text - a prompt text.
 * @returns `{ name, mention }` per occurrence; `name` has no leading `@`.
 */
export function mentionTokensIn(text) {
  if (typeof text !== 'string' || !text.includes('@')) return []
  const out = []
  const pattern = /(^|\s)@([^\s@]+)/gu
  let match
  while ((match = pattern.exec(text)) !== null) {
    const name = match[2].replace(MENTION_TRAILING_PUNCTUATION, '')
    if (name === '') continue
    out.push({ name, mention: `@${name}` })
  }
  return out
}

/**
 * Drop one mention occurrence from a prompt, keeping the rest of the text intact.
 * @param text - the original prompt text.
 * @param name - the token's name, with or without its leading `@`.
 * @returns the remaining text, trimmed.
 */
export function removeMentionToken(text, name) {
  const bare = String(name ?? '').replace(/^@/u, '')
  if (bare === '' || typeof text !== 'string') return text
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return text
    .replace(new RegExp(`(^|[\\s])@${escaped}(?=\\s|$)`, 'gu'), '$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/[ \t]+$/gmu, '')
    .trim()
}

/** The text blocks of one message, joined as the user wrote them. */
export function messageTextOf(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Render human-in-the-loop forms as assistant text.
 *
 * A Claw agent asks through `AskUserQuestion`, and the platform delivers the form as a
 * `questionnaire` content with **no text at all** — so a text-only bridge would drop the
 * question the turn was about. Answering matches the panel's protocol: the option's
 * label is the next message.
 * @param interactions - normalised descriptors from {@link extractInteractions}.
 * @returns Markdown for the assistant message, or '' when there is nothing to render.
 */
export function renderInteractions(interactions) {
  const list = Array.isArray(interactions) ? interactions : []
  const lines = []
  for (const item of list) {
    if (item?.kind === 'questionnaire') {
      lines.push(`**${item.title || '需要你确认'}**`)
      for (const question of Array.isArray(item.questions) ? item.questions : []) {
        const marks = [question.required === true ? '必填' : '', question.multiSelect === true ? '可多选' : '']
          .filter(Boolean)
        lines.push(`${(question.index ?? 0) + 1}. ${question.question}${marks.length === 0 ? '' : `（${marks.join('、')}）`}`)
        for (const option of Array.isArray(question.options) ? question.options : []) {
          lines.push(`   - **${option.label}**${option.description ? `：${option.description}` : ''}`)
        }
      }
      lines.push('直接回复你要选的选项名称即可继续。')
    } else if (item?.kind === 'file') {
      lines.push(`📄 ${item.name || '产出文件'}${item.url ? ` — ${item.url}` : ''}`)
    }
  }
  return lines.join('\n')
}

/** A stable ADP `UserId` for one DSH session, so a conversation keeps one visitor. */
export function mentionUserId(sessionId) {
  const compact = String(sessionId ?? '').replace(/[^a-zA-Z0-9]/gu, '')
  return compact === '' ? 'dshsession' : `dsh${compact.slice(0, 40)}`
}

/* ------------------------------------------------------------------ *
 * Plugin body
 * ------------------------------------------------------------------ */

/**
 * Register the ADP console: tools, the browser route, and the gate they share.
 * @param ctx - the Host plugin context.
 * @param config - the row's raw config, merged over {@link DEFAULT_CONFIG}.
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULT_CONFIG, ...(config ?? {}) }

  const statePath = resolveStatePath(settings)
  const state = {
    enabledAppIds: new Set(Array.isArray(settings.defaultEnabledAppIds) ? settings.defaultEnabledAppIds : []),
    credentials: {},
  }
  const stateReady = loadState(statePath).then((loaded) => {
    // Config-provided ids seed the gate; the persisted file is authoritative afterwards.
    if (state.enabledAppIds.size === 0) state.enabledAppIds = loaded.enabledAppIds
    state.credentials = loaded.credentials
    return undefined
  }).catch(() => undefined)
  /** Serialise writes so two quick toggles cannot interleave. */
  let writeQueue = Promise.resolve()
  const persist = () => {
    writeQueue = writeQueue.then(() => saveState(statePath, state)).catch((error) => {
      console.error(`[adp-console] could not persist ${statePath}: ${error.message}`)
    })
    return writeQueue
  }

  /** The site in force: what the panel saved, else the config, else 腾讯云. */
  function activeSite() {
    const key = state.credentials.site || settings.site
    return Object.hasOwn(SITES, key) ? key : 'cn'
  }

  /**
   * Effective credentials: what the panel saved wins, then the row config,
   * then the environment. The panel is the only writer at runtime.
   *
   * Host precedence: an explicit panel site choice beats the config's `endpoint`
   * (a standing default, which is also what a pre-restart generation reads),
   * which in turn beats the site table.
   */
  const credentials = {
    get secretId() {
      return state.credentials.secretId || settings.secretId || process.env.TENCENTCLOUD_SECRET_ID || ''
    },
    get secretKey() {
      return state.credentials.secretKey || settings.secretKey || process.env.TENCENTCLOUD_SECRET_KEY || ''
    },
    get region() { return state.credentials.region || settings.region },
    get spaceId() { return state.credentials.spaceId || settings.spaceId },
    get site() { return activeSite() },
    get endpoint() {
      if (state.credentials.site) return SITES[activeSite()].endpoint
      return settings.endpoint || SITES[activeSite()].endpoint
    },
    get chatEndpoint() {
      if (state.credentials.site) return SITES[activeSite()].chatEndpoint
      return settings.chatEndpoint || SITES[activeSite()].chatEndpoint
    },
    get wsEndpoint() {
      if (state.credentials.site) return SITES[activeSite()].wsEndpoint
      return settings.wsEndpoint || SITES[activeSite()].wsEndpoint
    },
    get protocol() { return settings.protocol },
    get useSdk() {
      // `DSH_ADP_NO_SDK=1` forces the built-in signer, so the fallback stays testable.
      return settings.useSdk !== false && process.env.DSH_ADP_NO_SDK !== '1'
    },
    get requestTimeoutMs() { return settings.requestTimeoutMs },
    get chatIdleTimeoutMs() { return settings.chatIdleTimeoutMs },
    get chatTimeoutMs() { return settings.chatTimeoutMs },
    get apiVersion() { return settings.apiVersion },
  }

  /** Where the active credentials came from, for the panel's settings card. */
  function credentialSource() {
    if (state.credentials.secretId && state.credentials.secretKey) return 'panel'
    if (settings.secretId && settings.secretKey) return 'config'
    if (process.env.TENCENTCLOUD_SECRET_ID && process.env.TENCENTCLOUD_SECRET_KEY) return 'env'
    return 'none'
  }

  /** The panel's settings payload, never the secrets themselves. */
  function configView() {
    const site = activeSite()
    return {
      configured: credentials.secretId !== '' && credentials.secretKey !== '',
      source: credentialSource(),
      secretIdHint: maskSecret(credentials.secretId),
      hasSecretKey: credentials.secretKey !== '',
      region: credentials.region,
      spaceId: credentials.spaceId,
      site,
      siteLabel: SITES[site].label,
      keySource: SITES[site].keySource,
      endpoint: credentials.endpoint,
      chatEndpoint: credentials.chatEndpoint,
      wsEndpoint: credentials.wsEndpoint,
      chatTransport: settings.chatTransport,
      chatIdleTimeoutMs: settings.chatIdleTimeoutMs,
      chatTimeoutMs: settings.chatTimeoutMs,
      statePath,
      chatEndpointHost: safeHost(credentials.chatEndpoint),
    }
  }

  const appKeyCache = new Map()

  /** Effective settings for a call, honouring the configured timeouts. */
  const callOptions = {
    releaseTimeoutMs: settings.releaseTimeoutMs,
  }

  /** Refresh the catalogue, decorating each row with gate + release state. */
  async function readCatalogue(options, signal) {
    await stateReady
    const statusList = options.status === 'all'
      ? undefined
      : options.status === 'offline' ? [APP_STATUS.OFFLINE]
        : options.status === 'disabled' ? [APP_STATUS.DISABLED]
          : [APP_STATUS.RUNNING]
    const { apps, total } = await listApps(credentials, {
      query: options.query,
      pageNumber: options.pageNumber,
      pageSize: options.pageSize,
      statusList,
    }, signal)
    return {
      apps: apps.map(summary => projectApp(summary, state.enabledAppIds.has(String(summary.AppId)), null)),
      total,
    }
  }

  /** Resolve (and cache) the conversation AppKey for an enabled app. */
  async function appKeyFor(appId, signal) {
    const cached = appKeyCache.get(appId)
    if (cached !== undefined && Date.now() - cached.at < settings.appKeyCacheMs) return cached.key
    const key = await resolveAppKey(credentials, appId, signal)
    appKeyCache.set(appId, { key, at: Date.now() })
    return key
  }

  /** Refuse a conversation for an app the user has not enabled. */
  function assertEnabled(appId) {
    if (state.enabledAppIds.has(appId)) return
    throw new AdpError(
      `应用 ${appId} 未上架（未启用），DSH 不能调用它。请先在 ADP 控制台面板中对该应用执行「上架 / 启用」。`,
      { code: 'AppNotEnabled' },
    )
  }

  /* ---------------- agent-facing tools ---------------- */

  if (settings.exposeTools) {
    ctx.effect(() => ctx.tools.register({
      name: 'adp_list_apps',
      description:
        'List Tencent Cloud ADP agent apps from the configured space, showing ADP publish status and whether '
        + 'this Harness may call the app. Use it before any ADP conversation to pick an app id.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Fuzzy match on the app name.' },
          status: {
            type: 'string',
            enum: ['running', 'offline', 'disabled', 'all'],
            description: 'ADP publish status filter. Defaults to running (已上线/已发布).',
          },
          onlyEnabled: { type: 'boolean', description: 'Return only apps this Harness may call.' },
          pageSize: { type: 'integer', description: 'Page size, 1-100. Defaults to 50.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: renderCatalogue(value) }],
      },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        const result = await readCatalogue({
          query: typeof input.query === 'string' ? input.query : undefined,
          status: typeof input.status === 'string' ? input.status : 'running',
          pageSize: Number.isInteger(input.pageSize) ? input.pageSize : 50,
        }, exec.signal)
        const apps = input.onlyEnabled === true ? result.apps.filter(app => app.dshEnabled) : result.apps
        return { total: result.total, count: apps.length, apps, statePath }
      },
    }), 'adp-console: adp_list_apps')

    ctx.effect(() => ctx.tools.register({
      name: 'adp_list_spaces',
      description:
        'List the ADP spaces this key can see and show which SpaceId is currently configured. '
        + 'Use it when an ADP call fails with a space error (e.g. 4510004-当前空间下没有该用户信息): '
        + 'the API needs the SpaceId (like "bfnUUoSh"), not the space name.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderSpaces(value) }] },
      async execute(_args, exec) {
        const spaces = await listSpaces(credentials, exec.signal)
        return { currentSpaceId: credentials.spaceId, spaces }
      },
    }), 'adp-console: adp_list_spaces')

    ctx.effect(() => ctx.tools.register({
      name: 'adp_set_app_enabled',
      description:
        '上架（启用）或下架（停止）一个 ADP 应用，决定 DSH 是否可以通过 ADP 会话接口调用它。'
        + 'This is the Harness-side gate: it does not change the app state on the ADP platform.',
      parameters: {
        type: 'object',
        properties: {
          appId: { type: 'string', description: 'ADP app id from adp_list_apps.' },
          enabled: { type: 'boolean', description: 'true = 上架/启用, false = 下架/停止.' },
        },
        required: ['appId', 'enabled'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderGate(value) }] },
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        const appId = typeof input.appId === 'string' ? input.appId.trim() : ''
        if (appId === '') throw new AdpError('appId is required', { code: 'InvalidArgs' })
        if (typeof input.enabled !== 'boolean') throw new AdpError('enabled must be a boolean', { code: 'InvalidArgs' })
        await stateReady
        if (input.enabled) state.enabledAppIds.add(appId)
        else state.enabledAppIds.delete(appId)
        await persist()
        resetMentionIndex()
        await ctx.emit?.('adp-console/changed', undefined)
        return { appId, dshEnabled: input.enabled, enabledAppIds: [...state.enabledAppIds].sort(), statePath }
      },
    }), 'adp-console: adp_set_app_enabled')

    ctx.effect(() => ctx.tools.register({
      name: 'adp_publish_app',
      description:
        'Publish (发布/上线) an ADP app by starting a release task and waiting for it to settle. '
        + 'An app must be published on ADP before the conversation API returns an AppKey.',
      parameters: {
        type: 'object',
        properties: {
          appId: { type: 'string', description: 'ADP app id from adp_list_apps.' },
          description: { type: 'string', description: 'Optional release note.' },
        },
        required: ['appId'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderRelease(value) }] },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        const appId = typeof input.appId === 'string' ? input.appId.trim() : ''
        if (appId === '') throw new AdpError('appId is required', { code: 'InvalidArgs' })
        const result = await publishApp(credentials, appId, {
          description: typeof input.description === 'string' ? input.description : undefined,
          releaseTimeoutMs: callOptions.releaseTimeoutMs,
        }, exec.signal)
        appKeyCache.delete(appId)
        return result
      },
    }), 'adp-console: adp_publish_app')

    ctx.effect(() => ctx.tools.register({
      name: 'adp_chat',
      description:
        'Send one message to a published ADP agent app through the ADP conversation API and return its full reply. '
        + 'The app must be 上架/启用 in this plugin first (see adp_list_apps / adp_set_app_enabled).',
      parameters: {
        type: 'object',
        properties: {
          appId: { type: 'string', description: 'ADP app id.' },
          message: { type: 'string', description: 'User message text.' },
          conversationId: {
            type: 'string',
            description: 'Reuse a previous conversation id to keep context. 32-64 chars of [A-Za-z0-9_-].',
          },
          userId: { type: 'string', description: 'Stable end-user id. Defaults to the DSH session id.' },
        },
        required: ['appId', 'message'],
        additionalProperties: false,
      },
      timeoutMs: settings.chatTimeoutMs,
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: renderChat(value) }] },
      async execute(args, exec) {
        await stateReady
        const input = args && typeof args === 'object' ? args : {}
        const appId = typeof input.appId === 'string' ? input.appId.trim() : ''
        const message = typeof input.message === 'string' ? input.message : ''
        if (appId === '') throw new AdpError('appId is required', { code: 'InvalidArgs' })
        if (message === '') throw new AdpError('message is required', { code: 'InvalidArgs' })
        assertEnabled(appId)
        const appKey = await appKeyFor(appId, exec.signal)
        const userId = normaliseId(input.userId) ?? newConversationId()
        const result = await runAdpChat({
          transport: settings.chatTransport,
          endpoint: credentials.chatEndpoint,
          wsEndpoint: credentials.wsEndpoint,
          idleTimeoutMs: settings.chatIdleTimeoutMs,
          timeoutMs: settings.chatTimeoutMs,
          appKey,
          message,
          conversationId: normaliseId(input.conversationId),
          userId,
          signal: exec.signal,
          openConversation: () => createApiConversation(credentials, appId, appKey, userId, exec.signal),
          openWebSocketToken: () => createWebSocketToken(credentials, appId, appKey, userId, exec.signal),
        })
        return { appId, conversationId: result.conversationId, transport: result.transport, reply: result.text }
      },
    }), 'adp-console: adp_chat')
  }

  /* ---------------- `@` mention bridge ---------------- */

  /**
   * Sessions bound to one ADP app, keyed by session id — `{ appId, name, body }`.
   *
   * In memory on purpose: the binding is a derived cache and the durable record of a
   * pick is the `@name` in the prompt itself, so a restarted Harness re-binds on the
   * next mention instead of resurrecting something the user cannot see.
   */
  const mentionRoutes = new Map()
  /** Picks recorded by the Client that the prompt carrying them has not arrived for yet. */
  const mentionPicks = new Map()
  /** ADP `ConversationId` per session + app, so a follow-up keeps its context. */
  const mentionConversations = new Map()
  /** Enabled-app index by mention token, refreshed at most `mentionIndexMs`. */
  let mentionIndex = { at: 0, byToken: new Map() }

  /** The apps this Harness may mention: 已上线 on ADP and 已上架 here. */
  async function mentionTargets(signal) {
    const { apps } = await readCatalogue({ status: 'running', pageSize: 100 }, signal)
    return apps
      .filter(app => app.dshEnabled)
      .map(app => ({
        appId: app.appId,
        name: app.name,
        // The mention token is derived here, not in the browser: the Host resolves the
        // same token back to this app, so both ends must agree on the spelling.
        token: mentionToken(app.name, app.appId),
        appModeLabel: app.appModeLabel,
        adpStatus: app.adpStatus,
        adpStatusLabel: app.adpStatusLabel,
      }))
  }

  /** Token → app for the enabled apps, cached for `mentionIndexMs`. */
  async function mentionIndexFor(signal) {
    if (Date.now() - mentionIndex.at < settings.mentionIndexMs) return mentionIndex.byToken
    const byToken = new Map()
    for (const target of await mentionTargets(signal)) byToken.set(target.token.toLowerCase(), target)
    mentionIndex = { at: Date.now(), byToken }
    return byToken
  }

  /** The gate changed, so the mention index describes applications that no longer apply. */
  function resetMentionIndex() {
    mentionIndex = { at: 0, byToken: new Map() }
  }

  /**
   * Resolve the `@` mention of one prompt against the session's armed pick.
   *
   * A Client pick is the exact app the user clicked; a hand-typed or pasted `@name`
   * falls back to the enabled-app index, which is also what makes a mention survive
   * being copied into another session.
   * @param sessionId - the session whose pick may be armed.
   * @param text - the newest user message text.
   * @param signal - the pre-step cancellation boundary.
   * @returns `{ appId, name }` (`appId: null` = the exit token), or undefined for none.
   */
  async function resolveMention(sessionId, text, signal) {
    const tokens = mentionTokensIn(text)
    const pick = mentionPicks.get(sessionId)
    if (pick !== undefined) {
      mentionPicks.delete(sessionId)
      const armed = Date.now() - pick.at <= settings.mentionPickTtlMs
      const carried = tokens.some(entry => entry.name.toLowerCase() === pick.name.toLowerCase())
      if (armed && carried) return { appId: pick.appId, name: pick.name }
    }
    if (tokens.length === 0) return undefined
    // `@DSH` typed by hand is the same exit the menu row performs.
    const exit = tokens.find(entry => entry.name.toLowerCase() === MENTION_EXIT_TOKEN.toLowerCase())
    if (exit !== undefined) return { appId: null, name: exit.name }
    try {
      const byToken = await mentionIndexFor(signal)
      for (const entry of tokens) {
        const hit = byToken.get(entry.name.toLowerCase())
        if (hit !== undefined) return { appId: hit.appId, name: entry.name }
      }
    } catch (error) {
      console.error(`[adp-console] 无法解析 @ 提及：${error.message}`)
    }
    return undefined
  }

  /**
   * Bind the session from its newest user message, and strip the mention from that
   * message: it addressed an app, not prose. A message with no mention keeps the
   * binding, so one conversation with one app stays a conversation.
   * @returns replacement messages when a mention had to be removed, else undefined.
   */
  async function claimMention(agent, messages, signal) {
    if (!Array.isArray(messages) || messages.length === 0) return undefined
    let claim
    for (const message of messages) {
      if (message?.source?.kind !== 'user') continue
      const text = messageTextOf(message)
      if (text.trim() === '') continue
      claim = { message, text }
    }
    if (claim === undefined) return undefined

    const sessionId = String(agent.session.id)
    const resolved = await resolveMention(sessionId, claim.text, signal)
    const previous = mentionRoutes.get(sessionId)
    if (resolved !== undefined && resolved.appId === null) {
      mentionRoutes.delete(sessionId)
    } else {
      const bound = resolved ?? previous
      if (bound !== undefined) {
        mentionRoutes.set(sessionId, {
          appId: bound.appId,
          name: bound.name,
          body: resolved === undefined ? claim.text : removeMentionToken(claim.text, resolved.name),
        })
      }
    }
    if (resolved === undefined) return undefined
    return messages.map((message) => {
      if (message !== claim.message) return message
      const content = message.content.map(block => block !== null && typeof block === 'object' && block.type === 'text'
        ? { ...block, text: removeMentionToken(block.text, resolved.name) }
        : block)
      return { ...message, content }
    })
  }

  /**
   * Answer one turn from the bound ADP app instead of the model.
   *
   * `llm/stream` is the documented seam for exactly this ("retry, replay, routing"):
   * yielding the chunks here short-circuits the provider call, and the loop assembles
   * the ADP answer into an ordinary assistant message. Nothing is thrown at the loop —
   * an ADP failure becomes visible text plus a terminal chunk, so a broken app answers
   * in the conversation instead of blanking the turn.
   */
  async function* streamMentionReply(sessionId, route, signal) {
    yield { type: 'block-start', index: 0, blockType: 'text' }

    /** Deltas the reducer produced but this generator has not yielded yet. */
    const queue = []
    let wake
    let finished = false
    let failure
    let result
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const conversationKey = `${sessionId}::${route.appId}`
    const userId = mentionUserId(sessionId)

    const chat = (async () => {
      try {
        await stateReady
        assertEnabled(route.appId)
        const appKey = await appKeyFor(route.appId, controller.signal)
        result = await runAdpChat({
          transport: settings.chatTransport,
          endpoint: credentials.chatEndpoint,
          wsEndpoint: credentials.wsEndpoint,
          idleTimeoutMs: settings.chatIdleTimeoutMs,
          timeoutMs: settings.chatTimeoutMs,
          appKey,
          message: route.body === '' ? MENTION_OPENING : route.body,
          conversationId: mentionConversations.get(conversationKey),
          userId,
          signal: controller.signal,
          onEvent: (_name, _payload, delta) => {
            if (!delta) return
            queue.push(delta)
            wake?.()
            wake = undefined
          },
          openConversation: async () => {
            const created = await createApiConversation(credentials, route.appId, appKey, userId, controller.signal)
            mentionConversations.set(conversationKey, created)
            return created
          },
          openWebSocketToken: () => createWebSocketToken(credentials, route.appId, appKey, userId, controller.signal),
        })
      } catch (error) {
        failure = error
      } finally {
        finished = true
        wake?.()
        wake = undefined
      }
    })()

    let text = ''
    try {
      for (;;) {
        if (queue.length > 0) {
          const delta = queue.shift()
          text += delta
          yield { type: 'text-delta', index: 0, text: delta }
          continue
        }
        if (finished) break
        await new Promise((resolve) => { wake = resolve })
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      // A consumer that stops early (the user hit stop) owns the cancellation.
      if (!finished) controller.abort(new Error('@ 会话被取消'))
    }
    await chat

    // The completion frame restates the whole answer; stream the part the deltas did
    // not carry so the visible text never loses its tail.
    const authoritative = typeof result?.text === 'string' ? result.text : ''
    if (authoritative !== '' && authoritative !== text) {
      if (authoritative.startsWith(text)) yield { type: 'text-delta', index: 0, text: authoritative.slice(text.length) }
      text = authoritative
    }
    const forms = renderInteractions(result?.interactions)
    if (forms !== '') {
      const addition = `${text === '' ? '' : '\n\n'}${forms}`
      text += addition
      yield { type: 'text-delta', index: 0, text: addition }
    }
    if (failure !== undefined) {
      const aborted = signal?.aborted === true || failure?.name === 'AbortError'
      const message = failure instanceof Error ? failure.message : String(failure)
      if (aborted) {
        if (text !== '') yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } }
        return
      }
      const addition = `${text === '' ? '' : '\n\n'}> ⚠️ ADP 会话失败：${message}`
      text += addition
      yield { type: 'text-delta', index: 0, text: addition }
      console.error(`[adp-console] @${route.name} 会话失败：${message}`)
    }
    if (text === '') text = '（ADP 应用没有返回任何内容。）'
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  if (settings.mentionEnabled !== false) {
    ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const rewritten = await claimMention(agent, decision.messages, signal)
      // Spread: the downstream decision may carry fields this listener knows nothing of.
      return rewritten === undefined ? decision : { ...decision, messages: rewritten }
    }), 'adp-console: @ mention binding')

    ctx.effect(() => ctx.on('llm/stream', (options, next) => {
      // Auxiliary calls (compaction, session titles) are the model's own bookkeeping.
      if (options.purpose !== undefined || options.sessionId === undefined) return next()
      const sessionId = String(options.sessionId)
      const route = mentionRoutes.get(sessionId)
      if (route === undefined) return next()
      return streamMentionReply(sessionId, route, options.signal)
    }), 'adp-console: @ mention bridge')

    ctx.effect(() => ctx.on('session/disposed', (session) => {
      const id = String(session.id)
      mentionRoutes.delete(id)
      mentionPicks.delete(id)
      for (const key of [...mentionConversations.keys()]) {
        if (key.startsWith(`${id}::`)) mentionConversations.delete(key)
      }
    }), 'adp-console: @ mention state')
  }

  /* ---------------- browser route for the Client panel ---------------- */

  // Scoped injection, not `ctx.get`: on a cold start this plugin activates before the
  // HTTP carrier exists, so a one-shot lookup would silently skip registration and the
  // panel would be left talking to a 404. `ctx.inject` runs the callback when the
  // service appears (and disposes it if the carrier goes away).
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: settings.routePrefix,
      async handler(req, res) {
        if (!isLoopbackAuthority(req.headers.host)) {
          sendJson(res, 403, { ok: false, error: '只允许本机访问。' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(settings.routePrefix.length) || '/'
        const send = value => sendJson(res, 200, { ok: true, ...value })
        const fail = (error, status = 200) => sendJson(res, status, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof AdpError ? error.code : undefined,
        })

        try {
          if (req.method === 'GET' && route === '/config') {
            await stateReady
            // Report which management transport is in force, so the panel can say
            // whether the official SDK is actually in use.
            const sdkConstructor = settings.useSdk === false ? null : await loadAdpSdk(true)
            send({
              ...configView(),
              sdk: {
                enabled: settings.useSdk !== false,
                available: sdkConstructor !== null,
                transport: settings.useSdk !== false && sdkConstructor !== null ? 'sdk' : 'builtin',
              },
            })
            return
          }
          if (req.method === 'POST' && route === '/config') {
            await stateReady
            const body = await readJsonBody(req)
            if (body.clear === true) {
              state.credentials = {}
            } else {
              if (typeof body.site === 'string') {
                if (!Object.hasOwn(SITES, body.site)) {
                  throw new AdpError(`未知站点 ${body.site}`, { code: 'InvalidArgs' })
                }
                state.credentials.site = body.site
              }
              for (const field of ['secretId', 'secretKey', 'region', 'spaceId']) {
                if (typeof body[field] === 'string') {
                  const value = body[field].trim()
                  if (value === '') delete state.credentials[field]
                  else state.credentials[field] = value
                }
              }
            }
            const touchedSecrets = typeof body.secretId === 'string' || typeof body.secretKey === 'string'
            if (touchedSecrets && (credentials.secretId === '' || credentials.secretKey === '')) {
              throw new AdpError('SecretId 和 SecretKey 必须同时提供。', { code: 'InvalidArgs' })
            }
            await persist()
            // A new key pair (or site) means every cached AppKey and SDK client belongs
            // to the old identity.
            appKeyCache.clear()
            resetSdkClients()
            const sdkConstructor = settings.useSdk === false ? null : await loadAdpSdk(true)
            send({
              ...configView(),
              sdk: {
                enabled: settings.useSdk !== false,
                available: sdkConstructor !== null,
                transport: settings.useSdk !== false && sdkConstructor !== null ? 'sdk' : 'builtin',
              },
            })
            return
          }
          if (req.method === 'POST' && route === '/verify') {
            await stateReady
            const report = await verifyCredentials({
              secretId: credentials.secretId,
              secretKey: credentials.secretKey,
              protocol: credentials.protocol,
              region: credentials.region,
              spaceId: credentials.spaceId,
              site: credentials.site,
              endpoint: credentials.endpoint,
              apiVersion: credentials.apiVersion,
            }, abortSignalFor(req, res))
            send(report)
            return
          }
          if (req.method === 'GET' && route === '/spaces') {
            await stateReady
            send({ currentSpaceId: credentials.spaceId, spaces: await listSpaces(credentials, abortSignalFor(req, res)) })
            return
          }
          if (req.method === 'GET' && route === '/apps') {
            const result = await readCatalogue({
              query: url.searchParams.get('query') ?? undefined,
              status: url.searchParams.get('status') ?? 'running',
              pageSize: clampInt(url.searchParams.get('pageSize'), 1, 100, 50),
              pageNumber: clampInt(url.searchParams.get('pageNumber'), 0, 1000, 0),
            }, abortSignalFor(req, res))
            await stateReady
            send({ ...result, enabledAppIds: [...state.enabledAppIds].sort() })
            return
          }
          if (req.method === 'GET' && route === '/mention-apps') {
            await stateReady
            const configured = credentials.secretId !== '' && credentials.secretKey !== ''
            const exit = { token: MENTION_EXIT_TOKEN, label: 'DSH 本体' }
            // `bridge` lets the Client drop the menu group entirely when this half is off.
            const bridge = settings.mentionEnabled !== false
            if (!configured || !bridge) {
              send({ configured, bridge, apps: [], exit })
              return
            }
            send({ configured, bridge, apps: await mentionTargets(abortSignalFor(req, res)), exit })
            return
          }
          if (req.method === 'POST' && route === '/bind') {
            await stateReady
            const body = await readJsonBody(req)
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
            const name = typeof body.token === 'string' ? body.token.trim().replace(/^@/u, '') : ''
            if (sessionId === '' || name === '') {
              throw new AdpError('sessionId 与 token 必填。', { code: 'InvalidArgs' })
            }
            const appId = body.appId === null || body.appId === undefined || body.appId === ''
              ? null
              : String(body.appId).trim()
            // The gate is the whole point of the console: a pick cannot arm an app it
            // could not call a moment later.
            if (appId !== null) assertEnabled(appId)
            mentionPicks.set(sessionId, { appId, name, at: Date.now() })
            if (appId === null) mentionRoutes.delete(sessionId)
            // A session that is picked into but never sends must not accumulate.
            if (mentionPicks.size > 200) {
              const cutoff = Date.now() - settings.mentionPickTtlMs
              for (const [key, value] of mentionPicks) {
                if (value.at < cutoff) mentionPicks.delete(key)
              }
            }
            send({ sessionId, appId, token: name })
            return
          }
          if (req.method === 'POST' && route === '/enabled') {
            const body = await readJsonBody(req)
            const appId = typeof body.appId === 'string' ? body.appId.trim() : ''
            if (appId === '') throw new AdpError('appId is required', { code: 'InvalidArgs' })
            await stateReady
            if (body.enabled === true) state.enabledAppIds.add(appId)
            else state.enabledAppIds.delete(appId)
            await persist()
            resetMentionIndex()
            send({ appId, dshEnabled: body.enabled === true, enabledAppIds: [...state.enabledAppIds].sort() })
            return
          }
          if (req.method === 'POST' && route === '/release') {
            const body = await readJsonBody(req)
            const appId = typeof body.appId === 'string' ? body.appId.trim() : ''
            if (appId === '') throw new AdpError('appId is required', { code: 'InvalidArgs' })
            const result = await publishApp(credentials, appId, {
              description: typeof body.description === 'string' ? body.description : undefined,
              releaseTimeoutMs: callOptions.releaseTimeoutMs,
            }, abortSignalFor(req, res))
            appKeyCache.delete(appId)
            send({ release: result })
            return
          }
          if (req.method === 'POST' && route === '/release-status') {
            const body = await readJsonBody(req)
            const appId = typeof body.appId === 'string' ? body.appId.trim() : ''
            if (appId === '') throw new AdpError('appId is required', { code: 'InvalidArgs' })
            send(await describeLatestRelease(credentials, appId, abortSignalFor(req, res)))
            return
          }
          if (req.method === 'POST' && route === '/chat') {
            await stateReady
            const body = await readJsonBody(req)
            const appId = typeof body.appId === 'string' ? body.appId.trim() : ''
            const message = typeof body.message === 'string' ? body.message : ''
            if (appId === '') throw new AdpError('appId is required', { code: 'InvalidArgs' })
            if (message === '') throw new AdpError('message is required', { code: 'InvalidArgs' })
            assertEnabled(appId)

            const signal = abortSignalFor(req, res)
            const appKey = await appKeyFor(appId, signal)
            const userId = normaliseId(typeof body.userId === 'string' ? body.userId : '')
              ?? `dshweb${newConversationId().slice(0, 16)}`

            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
            })
            const write = (name, payload) => {
              res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
            }
            try {
              const result = await runAdpChat({
                transport: settings.chatTransport,
                endpoint: credentials.chatEndpoint,
                wsEndpoint: credentials.wsEndpoint,
                idleTimeoutMs: settings.chatIdleTimeoutMs,
                timeoutMs: settings.chatTimeoutMs,
                appKey,
                message,
                conversationId: normaliseId(body.conversationId),
                userId,
                signal,
                onEvent: (name, payload, text, patch) => {
                  // One frame can carry all three: a timeline patch, the flat answer delta,
                  // and the raw event for the panel's event list.
                  if (patch) write('console.entry', patch)
                  if (text) write('console.delta', { text })
                  write('adp.event', { name, label: eventLabel(name, payload) })
                },
                openConversation: async () => {
                  const created = await createApiConversation(credentials, appId, appKey, userId, signal)
                  // Tell the panel which conversation it is now in, so a follow-up turn
                  // keeps the context rather than opening a new one.
                  write('console.meta', { conversationId: created, appId })
                  return created
                },
                openWebSocketToken: () => createWebSocketToken(credentials, appId, appKey, userId, signal),
              })
              write('console.done', {
                text: result.text,
                conversationId: result.conversationId,
                transport: result.transport,
                // Human-in-the-loop forms (and files) ride along so the panel can render
                // them; a questionnaire turn can carry no text at all.
                interactions: result.interactions ?? [],
                // The authoritative turn timeline, so the panel can reconcile anything it
                // assembled from the incremental patches.
                timeline: result.timeline ?? [],
              })
            } catch (error) {
              write('console.error', {
                error: error instanceof Error ? error.message : String(error),
                code: error?.code,
                // A stalled or closed turn may still hold a usable partial answer.
                partialText: error?.partialText ?? '',
              })
            }
            res.end()
            return
          }
          fail(new AdpError(`unknown route ${req.method} ${route}`, { code: 'NotFound' }), 404)
        } catch (error) {
          if (res.headersSent) {
            res.end()
            return
          }
          fail(error)
        }
      },
    }), 'adp-console: browser route')
  })
}

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

/** Clamp a query-string integer. */
function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Accept a 32-64 char id, or undefined when it does not fit the API grammar. */
function normaliseId(value) {
  if (typeof value !== 'string') return undefined
  return /^[a-zA-Z0-9_-]{32,64}$/.test(value) ? value : undefined
}

/** Bind a request's lifetime to an AbortSignal. */
function abortSignalFor(req, res) {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('client disconnected'))
  req.on('aborted', abort)
  res.on('close', abort)
  return controller.signal
}

/** Drop values that cannot survive `JSON.stringify`. */
function serialisable(value, depth = 0) {
  if (depth > 6) return '[deep]'
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(item => serialisable(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value).slice(0, 50)) out[key] = serialisable(child, depth + 1)
    return out
  }
  return undefined
}

/** Tool text: the catalogue. */
function renderCatalogue(value) {
  const apps = Array.isArray(value?.apps) ? value.apps : []
  if (apps.length === 0) return '没有匹配的 ADP 应用。'
  const lines = apps.map((app) => {
    const gate = app.dshEnabled ? '已上架(DSH 可调用)' : '已下架(DSH 不可调用)'
    return `- ${app.name || '(未命名)'} · ${app.appId} · ADP ${app.adpStatusDescription || '未知'} · ${gate}`
  })
  return `共 ${value?.count ?? apps.length}/${value?.total ?? apps.length} 个应用：\n${lines.join('\n')}`
}

/** Tool text: the gate write. */
function renderGate(value) {
  return `${value?.appId} → ${value?.dshEnabled ? '上架（DSH 可调用）' : '下架（DSH 不可调用）'}`
}

/** Tool text: a release task. */
function renderRelease(value) {
  return `发布任务 ${value?.releaseId ?? '(未知)'} → ${value?.status ?? 'unknown'} ${value?.statusDescription ?? ''}`.trim()
}

/** Tool text: the spaces this key can see. */
function renderSpaces(value) {
  const spaces = Array.isArray(value?.spaces) ? value.spaces : []
  if (spaces.length === 0) return '这把密钥看不到任何 ADP 空间。'
  return `当前配置的 SpaceId：${value?.currentSpaceId || '(未设置)'}\n` + spaces.map((space) => {
    const mark = space.spaceId === value?.currentSpaceId ? ' ← 当前' : ''
    return `- SpaceId=${space.spaceId} · 名称=${space.name || '(无)'}${mark}`
  }).join('\n')
}

/** Tool text: one chat turn. */
function renderChat(value) {
  return value?.reply ? String(value.reply) : '(ADP 未返回文本内容)'
}
