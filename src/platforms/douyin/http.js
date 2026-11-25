/**
 * 抖音纯 HTTP 通道：带 a_bogus（+ 需要时 x-secsdk-web-signature）直连 Web API，
 * 不开浏览器。
 *
 * 三条签名规则（实测得出，与 CreatorHub 的 client.py 一致）：
 *   1. 搜索族（`/general/search/single|stream/`）：**不加** a_bogus——加了会被判风控，
 *      返回 `search_nil_type: verify_check`；不加则正常出数据。
 *   2. 受 webSign 保护的路径（`/aweme/post/` 等）：a_bogus + 设备号绑定签名 + 三个请求头，
 *      缺一样就是 403 `Blocked by ArgusSecurityPlugin ...`。
 *   3. 其余接口：a_bogus + msToken（cookie 里没有就随机假 token）即可，例如 `profile/self/`。
 */
import { signQuery, DEFAULT_FP } from './abogus.js'
import { signWebQuery, isSearchPath, needsWebSignature, uifidFromCookie } from './websign.js'

export const DOUYIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'

/** 所有接口都要带的公共参数（与第一方 web 端一致）。 */
export const COMMON_PARAMS = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '190600',
  version_name: '19.6.0',
  cookie_enabled: 'true',
  screen_width: '1536',
  screen_height: '864',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Edge',
  browser_version: '140.0.0.0',
  browser_online: 'true',
  engine_name: 'Blink',
  engine_version: '140.0.0.0',
  os_name: 'Windows',
  os_version: '10',
  platform: 'PC',
  downlink: '10',
  effective_type: '4g',
  round_trip_time: '150',
}

/** 与 COMMON_PARAMS 中屏幕尺寸一致的 a_bogus 指纹串。 */
export function fingerprintOf(common = COMMON_PARAMS) {
  const w = Number(common.screen_width) || 1536
  const h = Number(common.screen_height) || 864
  const plat = common.browser_platform || 'Win32'
  return (
    `${w}|${h}|${w + 24}|${h + 80}|0|0|0|0|` +
    `${w}|${h}|${w}|${h}|${w}|${h}|24|24|${plat}`
  )
}

const MS_TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=_-'

/** 生成一个 126 位的假 msToken（第一方在没有真 token 时也接受这种形态）。 */
export function fakeMsToken(len = 126) {
  let out = ''
  for (let i = 0; i < len; i++) out += MS_TOKEN_CHARS[Math.floor(Math.random() * MS_TOKEN_CHARS.length)]
  return out
}

/** 把 CDP 的 cookie（数组或 Map<name,value>）拼成 Cookie 头需要的整段字符串。 */
export function cookieStringOf(cookies) {
  if (typeof cookies === 'string') return cookies
  if (cookies instanceof Map) {
    return [...cookies.entries()]
      .filter(([name, value]) => name && typeof value === 'string')
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }
  if (Array.isArray(cookies)) {
    return cookies
      .filter((c) => c && c.name && typeof c.value === 'string')
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
  }
  return ''
}

/** 从整段 cookie 里取某个键的值，取不到返回 ''。 */
export function cookieValue(cookie, name) {
  const m = String(cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'))
  return m ? m[1] : ''
}

/**
 * 组装一次请求的 URL 与请求头（签名就在这一步完成）。
 * 单独导出便于单测直接断言签名是否按路径规则生效。
 */
export function buildRequest(path, params, { cookie = '', ua = DOUYIN_UA, fp, body } = {}) {
  const query = new URLSearchParams({ ...COMMON_PARAMS, ...(params || {}) })
  let qs = query.toString()
  const headers = {
    'User-Agent': ua,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://www.douyin.com/',
    Cookie: cookie,
  }
  if (isSearchPath(path)) {
    // 搜索族：不签名；设备号放 query 里（第一方也这么做）
    const dev = uifidFromCookie(cookie)
    if (dev && !query.has('uifid')) qs += `&uifid=${encodeURIComponent(dev)}`
    return { url: `https://www.douyin.com${path}?${qs}`, headers, signed: 'none' }
  }
  if (!query.has('msToken')) qs += `&msToken=${fakeMsToken()}`
  qs = signQuery(qs, ua, { fp: fp || fingerprintOf(), body })
  if (needsWebSignature(path)) {
    const dev = uifidFromCookie(cookie)
    if (dev) {
      const sealed = signWebQuery(qs, dev)
      return {
        url: `https://www.douyin.com${path}?${sealed.query}`,
        headers: { ...headers, ...sealed.headers },
        signed: 'abogus+web',
      }
    }
  }
  return { url: `https://www.douyin.com${path}?${qs}`, headers, signed: 'abogus' }
}

/**
 * 创建纯 HTTP 客户端。
 * @param {{cookie: string, ua?: string, log?: (m: string) => void, fetchImpl?: typeof fetch}} opts
 */
export function createDouyinHttp({ cookie, ua = DOUYIN_UA, log = () => {}, fetchImpl = fetch } = {}) {
  let jar = String(cookie || '')

  async function request(path, params, { referer, body } = {}) {
    const built = buildRequest(path, params, { cookie: jar, ua, body })
    const headers = referer ? { ...built.headers, Referer: referer } : built.headers
    const res = await fetchImpl(built.url, { headers })
    const text = await res.text()
    return { status: res.status, text, signed: built.signed }
  }

  return {
    get cookie() {
      return jar
    },
    setCookie(next) {
      jar = String(next || '')
    },
    request,
    /** 取本人资料：昵称 / uid / sec_uid。 */
    async selfProfile() {
      const r = await request('/aweme/v1/web/user/profile/self/', {}, { referer: 'https://www.douyin.com/user/self' })
      return parseJsonOrNull(r.text)
    },
  }
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export { DEFAULT_FP }
