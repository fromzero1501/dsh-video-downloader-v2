/**
 * 抖音 web 端「账号绑定签名」：x-secsdk-web-signature。
 *
 * 背景（实测）：`/aweme/v1/web/aweme/post/` 这类路径除了 a_bogus，还要一个与设备号
 * 绑定的签名，否则被边缘层拦掉，返回 403 纯文本：
 *   - 不带设备号 → `Blocked by ArgusSecurityPlugin Uifid Not Found`
 *   - 带设备号但不签名 → `Blocked by ArgusSecurityPlugin Signature Not Found`
 * 补上本模块的签名后即 200。
 *
 * 算法：把 query 原样重排（去掉旧的签名与 timestamp，uifid 换成设备号并只留一个，
 * 末尾追加秒级 timestamp），按 RFC 允许字符集编码后用
 * `md5(设备号 + "_" + 时间戳 + "_" + 固定盐 + "_" + 规范化 query)` 得 32 位 hex。
 * 请求头还需同时带 uifid / x-secsdk-web-signature / x-secsdk-web-expire。
 */

import { createHash } from 'node:crypto'

/** 第一方 webSign 使用的固定盐。 */
const WEB_SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E'
export const WEB_SIGNATURE_HEADER = 'x-secsdk-web-signature'
export const WEB_EXPIRE_HEADER = 'x-secsdk-web-expire'

/** cookie 里可能存设备号的键，按优先级排列（大小写都试过，实际只有大写 UIFID 有值）。 */
export const UIFID_COOKIES = ['uifid', 'uifid_temp', 'uifidtemp', 'UIFID', 'UIFID_TEMP', 'UIFIDTEMP']

/** 需要「a_bogus + 设备号绑定签名」的接口路径（第一方 webSign 保护面）。 */
const WEB_SIGNED_PATHS = new Set([
  '/aweme/v1/web/aweme/detail/',
  '/aweme/v1/web/aweme/post/',
  '/aweme/v1/web/aweme/favorite/',
  '/aweme/v1/web/aweme/listcollection/',
  '/aweme/v1/web/mix/aweme/',
  '/aweme/v1/web/tab/feed/',
  '/aweme/v1/web/mix/list/',
  '/aweme/v1/web/music/aweme/',
  '/aweme/v1/web/music/list/',
  '/aweme/v1/web/mix/detail/',
  '/aweme/v1/web/mix/listcollection/',
  '/aweme/v1/web/music/detail/',
  '/aweme/v1/web/collects/list/',
  '/aweme/v1/web/collects/video/list/',
])

/** 搜索类路径：加 a_bogus 反而会被判风控（实测 verify_check），所以一律不签。 */
const SEARCH_PATHS = new Set([
  '/aweme/v1/web/general/search/single/',
  '/aweme/v1/web/general/search/stream/',
])

/** 规范化路径：补前导斜杠、补尾斜杠。 */
function normPath(path) {
  let p = '/' + String(path || '').replace(/^\/+/, '')
  if (!p.endsWith('/')) p += '/'
  return p
}

/** 这条路径是否需要设备号绑定签名。 */
export function needsWebSignature(path) {
  return WEB_SIGNED_PATHS.has(normPath(path))
}

/** 这条路径是否属于搜索族（不加 a_bogus）。 */
export function isSearchPath(path) {
  return SEARCH_PATHS.has(normPath(path))
}

/** 设备号是否看起来合法（非空、无空白与控制字符、不过长）。 */
export function validDeviceId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s;\x00-\x1f\x7f]/.test(value)
}

/** 从整段 cookie 字符串里挑一个合法设备号，挑不到返回 ''。 */
export function uifidFromCookie(cookie) {
  const text = String(cookie || '')
  for (const name of UIFID_COOKIES) {
    const m = text.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'))
    if (m && validDeviceId(m[1])) return m[1]
  }
  return ''
}

/**
 * Python `quote(value, safe="!~*'()-._")` 的等价实现：
 * encodeURIComponent 会把 ! ' ( ) * ~ - . 里的大部分编码，这里还原回原字符。
 */
function quoteWeb(value) {
  return encodeURIComponent(String(value))
    .replace(/%21/g, '!')
    .replace(/%27/g, "'")
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%2A/g, '*')
    .replace(/%7E/g, '~')
    .replace(/%2D/g, '-')
    .replace(/%2E/g, '.')
}

/**
 * 给 query 加设备号绑定签名。
 * @param {string} query 已含全部业务参数的 query（可以已带 a_bogus，顺序会被保留）
 * @param {string} deviceId cookie 里的 UIFID
 * @param {{timestamp?: number, md5?: (text: string) => string}} [opts] timestamp 秒级；md5 便于测试注入
 * @returns {{query: string, deviceId: string, timestamp: string, signature: string, headers: Record<string,string>}}
 */
export function signWebQuery(query, deviceId, opts = {}) {
  if (!validDeviceId(deviceId)) throw new Error('invalid_device_id')
  const md5 = opts.md5 || defaultMd5
  const stamp = String(
    opts.timestamp != null ? opts.timestamp : Math.floor(Date.now() / 1000),
  )
  const fields = []
  let hasDevice = false
  for (const [name, value] of new URLSearchParams(String(query || ''))) {
    if (name === WEB_SIGNATURE_HEADER || name === 'timestamp') continue
    let v = value
    if (name === 'uifid') {
      if (hasDevice) continue
      v = deviceId
      hasDevice = true
    }
    fields.push([name, v])
  }
  if (!hasDevice) fields.push(['uifid', deviceId])
  fields.push(['timestamp', stamp])
  const covered = fields.map(([n, v]) => `${n}=${quoteWeb(v)}`).join('&')
  const signature = md5(`${deviceId}_${stamp}_${WEB_SALT}_${covered}`)
  return {
    query: `${covered}&${WEB_SIGNATURE_HEADER}=${signature}`,
    deviceId,
    timestamp: stamp,
    signature,
    headers: {
      uifid: deviceId,
      [WEB_SIGNATURE_HEADER]: signature,
      [WEB_EXPIRE_HEADER]: stamp,
    },
  }
}

let md5Impl = (text) => createHash('md5').update(text, 'utf8').digest('hex')
/** 惰性加载 node:crypto 的 md5，保持本模块在纯计算测试下可注入替身。 */
function defaultMd5(text) {
  return md5Impl(text)
}
