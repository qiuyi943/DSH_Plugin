/**
 * List the ADP spaces this key can see.
 *
 * `DescribeSpaceList` is the documented way to find a usable `SpaceId`; the walkthrough
 * notes that `default_space` is only a built-in fallback and that a real space id looks
 * like `UYiGYydT`:
 * https://cloud.tencent.com/document/product/1759/133869 (步骤 1：创建空间)
 *
 *   node test/spaces.mjs [state.json path]
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITES, buildTc3Headers } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))

const statePath = process.argv[2]
  ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'adp-console', 'state.json')

/**
 * The site the plugin itself would use: the bundle patch is the standing default,
 * because a panel site choice lands in the state file and is read below.
 */
async function siteFromPatch() {
  try {
    const patch = await readFile(join(here, '..', 'cordis.patch.yml'), 'utf8')
    return /^\s*site:\s*(\S+)\s*$/m.exec(patch)?.[1]
  } catch {
    return undefined
  }
}

let stored = {}
try {
  stored = JSON.parse(await readFile(statePath, 'utf8')).credentials ?? {}
} catch (error) {
  console.log(`state file ${statePath}: ${error.message}`)
}

const secretId = stored.secretId || process.env.TENCENTCLOUD_SECRET_ID || ''
const secretKey = stored.secretKey || process.env.TENCENTCLOUD_SECRET_KEY || ''
const site = stored.site || process.env.DSH_ADP_SITE || await siteFromPatch() || 'cn'
const region = stored.region || 'ap-guangzhou'
const endpoint = process.env.DSH_ADP_ENDPOINT || SITES[site]?.endpoint || SITES.cn.endpoint

console.log(`state file : ${statePath}`)
console.log(`SecretId   : ${secretId === '' ? '(missing)' : `${secretId.slice(0, 4)}…${secretId.slice(-4)} (len ${secretId.length})`}`)
console.log(`site       : ${site} (${SITES[site]?.label ?? '未知'})`)
console.log(`endpoint   : ${endpoint}`)
console.log(`current id : ${stored.spaceId || '(unset)'}`)
console.log('')

if (secretId === '' || secretKey === '') {
  console.log('没有可用密钥。')
  process.exit(1)
}

/** One signed DescribeSpaceList call. */
async function listSpaces() {
  const timestamp = Math.floor(Date.now() / 1000)
  const { headers, body } = buildTc3Headers({
    secretId, secretKey, endpoint, service: 'adp', action: 'DescribeSpaceList',
    version: '2026-05-20', region, payload: { Query: '' }, timestamp,
  })
  const response = await fetch(`https://${endpoint}/`, { method: 'POST', headers, body })
  const text = await response.text()
  return JSON.parse(text)
}

let payload
try {
  payload = await listSpaces()
} catch (error) {
  console.log(`请求失败：${error.message}`)
  process.exit(1)
}

const response = payload.Response ?? payload
if (response.Error) {
  console.log(`接口报错：${response.Error.Code} — ${response.Error.Message}`)
  process.exit(1)
}

const spaces = Array.isArray(response.SpaceList) ? response.SpaceList : []
if (spaces.length === 0) {
  console.log('这把密钥看不到任何空间（可能需要先 CreateSpace，或密钥没有空间权限）。')
  process.exit(1)
}

console.log(`共 ${spaces.length} 个空间：\n`)
for (const space of spaces) {
  const id = space.SpaceId ?? '(no id)'
  const mark = id === stored.spaceId ? '  ← 当前配置' : ''
  console.log(`  SpaceId = ${id}`)
  console.log(`    Name        : ${space.Name ?? ''}`)
  if (space.Description) console.log(`    Description : ${space.Description}`)
  console.log(`${mark}`)
}
console.log('\n把上面某个 SpaceId 填进面板「设置 → 空间 ID」即可。')
