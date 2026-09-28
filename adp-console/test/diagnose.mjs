/**
 * Credential diagnostic.
 *
 * Answers "is this key pair usable, on which site, and if not why?" without printing
 * the secrets: it runs the same `verifyCredentials` the panel's 「检测凭证」 button uses,
 * then prints each probe and the attribution.
 *
 *   node test/diagnose.mjs [state.json path]
 *
 * Credentials come from the plugin state file, else from
 * TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SITES, verifyCredentials } from '../index.js'

const statePath = process.argv[2]
  ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'adp-console', 'state.json')

let stored = {}
try {
  stored = JSON.parse(await readFile(statePath, 'utf8')).credentials ?? {}
} catch (error) {
  console.log(`state file ${statePath}: ${error.message}`)
}

const secretId = stored.secretId || process.env.TENCENTCLOUD_SECRET_ID || ''
const secretKey = stored.secretKey || process.env.TENCENTCLOUD_SECRET_KEY || ''
const site = stored.site || process.env.DSH_ADP_SITE || 'cn'
const region = stored.region || 'ap-guangzhou'
const spaceId = stored.spaceId || 'default_space'

console.log(`state file : ${statePath}`)
console.log(`SecretId   : ${secretId === '' ? '(missing)' : `${secretId.slice(0, 4)}…${secretId.slice(-4)} (len ${secretId.length})`}`)
console.log(`SecretKey  : ${secretKey === '' ? '(missing)' : `len ${secretKey.length}`}`)
console.log(`site       : ${site} (${SITES[site]?.label ?? '未知'}) · 密钥来源：${SITES[site]?.keySource ?? '未知'}`)
console.log(`region     : ${region}`)
console.log(`spaceId    : ${spaceId}`)
console.log('')

if (secretId === '' || secretKey === '') {
  console.log('没有可用的密钥。请先在面板「设置」里保存，或导出 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY。')
  process.exit(1)
}

const report = await verifyCredentials({
  secretId,
  secretKey,
  protocol: 'https',
  region,
  spaceId,
  site,
  endpoint: SITES[site]?.endpoint ?? SITES.cn.endpoint,
  apiVersion: '2026-05-20',
})

for (const check of report.checks) {
  const mark = check.ok ? 'OK  ' : 'FAIL'
  console.log(`[${mark}] ${check.label}  <${check.endpoint}>`)
  if (!check.ok) console.log(`         ${check.message.split('\n')[0]}`)
  else console.log(`         ${check.message}`)
}

const VERDICT = {
  ok: '密钥可用，当前站点的 ADP 接口正常。',
  'wrong-site': '密钥有效，但属于另一个站点 —— 把面板「站点」切到上面通过的那一个。',
  'bad-key': '这组密钥在任何站点都不存在：请到当前站点的密钥来源重新获取（见上面「密钥来源」）。',
  'adp-permission': '密钥有效，但当前站点的 ADP 接口被拒：确认账号已开通 ADP、已加入该空间、密钥有权限。',
}

console.log('')
console.log(`结论（${site}）：${VERDICT[report.verdict] ?? report.verdict}`)
process.exitCode = report.verdict === 'ok' ? 0 : 1
