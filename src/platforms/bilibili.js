/**
 * B站（哔哩哔哩）批量入口：关键词搜索 + 作者主页作品列表。
 *
 * 通道：纯 HTTP，不需要浏览器。两个接口都要 WBI 签名：
 *   w_rid = md5(排序后的 query + mixin_key)，参数里注入秒级 wts。
 *   mixin_key 由 nav 接口的 wbi_img.img_url / sub_url 各取末段文件名的首段，
 *   拼接后按 64 项 MIXIN_INDEX 重排、截前 32 位。未登录时 nav 返回 -101 但 wbi_img 照给。
 *
 * 两个接口（2026-11-25 实测通过，未登录可用）：
 *   /x/web-interface/wbi/search/type  search_type=video&keyword=&page=&page_size<=50&order=  → data.result[] / data.numPages
 *   /x/space/wbi/arc/search           mid=&ps<=50&pn=&order=pubdate&platform=web&web_location=1550101
 *                                     → data.list.vlist[] / data.page.count
 *
 * 注意两条通道字段不一致：搜索有 like，作者作品列表**没有**点赞（只有 play），
 * 所以作者入口不参与「最低点赞」筛选（由 supportsLikeFilter 声明，避免整批被筛空）。
 */

import { createHash } from 'node:crypto'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type'
const ARC_URL = 'https://api.bilibili.com/x/space/wbi/arc/search'
const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi'

/** 两次搜索/翻页请求之间的最小间隔。实测连打 3 次就 -352，排队比事后重试划算。 */
export const BILI_MIN_GAP_MS = 1100

/**
 * 作者主页接口的风控参数。2026-11-25 实测：只加 wbi 签名会 412 request was banned，
 * 必须同时带 buvid3/buvid4 cookie + 这四个 dm_* 参数 + space.bilibili.com 的 referer。
 * 缺任意一项都 412（四种组合的对照结果见 probe-bili-space.mjs）。
 * dm_img_str / dm_cover_img_str 是 WebGL 指纹的 base64，服务端只校验格式，固定值可用。
 */
export const BILI_DM_PARAMS = {
  dm_img_list: '[]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
  dm_cover_img_str:
    'QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwICgweDAwMDAzRTlCKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzApLCBvciBzaW1pbGFy',
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
}

/** 官方 64 项重排表：顺序变了签名就全错，不要改。 */
export const MIXIN_INDEX = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

/** 取 URL 末段文件名里第一个点之前的部分；非法 URL 给空串。 */
export function wbiUrlKey(value) {
  if (!value) return ''
  try {
    const u = new URL(String(value))
    const tail = (u.pathname || '').split('/').pop() || ''
    return tail.split('.')[0] || ''
  } catch {
    return ''
  }
}

/** nav 的 wbi_img → mixin_key（拼接后按表重排取前 32 位）。 */
export function wbiMixinKey(wbi) {
  const joined = `${wbiUrlKey(wbi?.img_url || '')}${wbiUrlKey(wbi?.sub_url || '')}`
  return MIXIN_INDEX.map((i) => joined[i] || '').join('').slice(0, 32)
}

/** WHATWG URLSearchParams 风格的编码：空格转 +，~ 转 %7E。 */
function encodeForm(s) {
  return encodeURIComponent(s).replace(/%20/g, '+').replace(/~/g, '%7E')
}

/**
 * WBI 签名。参数值先剔除 [!'()*]（官方规则，漏了带感叹号的关键词就签错），
 * 再按 key 升序排列，最后 md5(query + mixinKey)。
 */
export function wbiSign(mixinKey, params, nowSec = Math.floor(Date.now() / 1000)) {
  const merged = { ...params, wts: nowSec }
  const pairs = Object.entries(merged)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => [String(k), String(v).replace(/[!'()*]/g, '')])
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const query = pairs.map(([k, v]) => `${encodeForm(k)}=${encodeForm(v)}`).join('&')
  return { query, signedQuery: `${query}&w_rid=${md5Hex(query + mixinKey)}` }
}

function md5Hex(text) {
  return createHash('md5').update(text).digest('hex')
}

/** 标题带 <em class="keyword"> 高亮标签，落盘前必须清掉。 */
export function cleanBiliTitle(title) {
  return String(title ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** "1:02:03" / "00:22" → 毫秒；解不出给 0。 */
export function biliDurationMs(text) {
  const parts = String(text ?? '').split(':').map((x) => Number(x))
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0
  let sec = 0
  for (const n of parts) sec = sec * 60 + n
  return Math.round(sec * 1000)
}

/** 搜索行 / 作者作品行 → 爬取统一行。 */
export function biliRow(item, { keyword = '', source = 'search' } = {}) {
  const bvid = String(item?.bvid || '')
  if (!bvid) return null
  const seconds = Number(item?.pubdate ?? item?.created ?? 0) || 0
  const row = {
    id: bvid,
    caption: cleanBiliTitle(item?.title) || bvid,
    author: String(item?.author || ''),
    // 作者 id 要带着：作者主页入口靠它翻页，缺了就只能让调用方另外去查。
    mid: String(item?.mid || ''),
    viewCount: Number(item?.play) || 0,
    timestampMs: seconds > 0 ? seconds * 1000 : 0,
    durationMs: biliDurationMs(item?.duration ?? item?.length),
    pageUrl: `https://www.bilibili.com/video/${bvid}`,
    keyword,
    source: null,
  }
  // 作者作品列表不返回点赞，这里不要伪造 0——筛选那边靠 supportsLikeFilter 关掉点赞条件。
  if (source === 'search') row.likeCount = Number(item?.like) || 0
  return row
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url, { referer, signal, cookie } = {}) {
  const headers = {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    ...(referer ? { referer } : {}),
    ...(cookie ? { cookie } : {}),
  }
  const res = await fetch(url, { headers, signal })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

/** B站错误码 → 统一判定。风控 -412 / -352，登录 -101，其余当 blocked。 */
export function biliVerdict(status, json, text = '') {
  if (status === 412 || status === 429) return { kind: 'rate_limited', message: `HTTP ${status}，请求过快` }
  const code = json?.code
  if (code === 0 || code === undefined || code === null) return { kind: 'ok', message: '' }
  const msg = String(json?.message || '').trim() || `code=${code}`
  if (code === -101) return { kind: 'need_login', message: msg }
  if (code === -412 || code === -352 || code === -509) return { kind: 'rate_limited', message: msg }
  if (code === -400) return { kind: 'blocked', message: `请求参数被拒：${msg}` }
  if (code === -404 || code === -400404) return { kind: 'blocked', message: msg }
  if (!json && /访问权限|风控|验证/.test(String(text).slice(0, 200))) {
    return { kind: 'captcha', message: 'B站要求人机验证' }
  }
  return { kind: 'blocked', message: msg }
}

/**
 * B站适配器。
 * deps 由 index.js 注入：resolveBilibili / downloadBilibili 是插件内已有的单链解析与下载，
 * 这里不重复实现 DASH 选流与 ffmpeg 合并。
 */
export function createBilibiliAdapter({ resolveBilibili, downloadBilibili, quality = 'best' } = {}) {
  let cachedKey = ''
  let cachedAt = 0
  let cachedBuvid = ''
  let cachedBuvidAt = 0
  let lastRequestAt = 0

  /** 匿名指纹 cookie：作者主页接口没有它直接 412，缓存 12 小时。 */
  async function buvidCookie({ signal } = {}) {
    if (cachedBuvid && Date.now() - cachedBuvidAt < 12 * 3600000) return cachedBuvid
    const r = await getJson(SPI_URL, { referer: 'https://www.bilibili.com/', signal })
    const b3 = String(r.json?.data?.b_3 || '')
    const b4 = String(r.json?.data?.b_4 || '')
    cachedBuvid = [b3 ? `buvid3=${b3}` : '', b4 ? `buvid4=${b4}` : ''].filter(Boolean).join('; ')
    cachedBuvidAt = Date.now()
    return cachedBuvid
  }

  async function mixinKey({ signal } = {}) {
    // mixin_key 每天轮换一次，缓存 1 小时足够；换表/失效时签名会 -403，调用方会重取一次。
    if (cachedKey && Date.now() - cachedAt < 3600000) return cachedKey
    const nav = await getJson(NAV_URL, { referer: 'https://www.bilibili.com/', signal })
    const wbi = nav.json?.data?.wbi_img
    const key = wbiMixinKey(wbi || {})
    if (!key) throw Object.assign(new Error(`B站 nav 未返回 wbi_img（HTTP ${nav.status}）`), { code: 'blocked' })
    cachedKey = key
    cachedAt = Date.now()
    return key
  }

  async function signedGet(baseUrl, params, { referer, signal, retryOnSign = true } = {}) {
    const key = await mixinKey({ signal })
    const { signedQuery } = wbiSign(key, params)
    // B站风控是按请求频率算的：同一 IP 连打几次就 -352。这里自己排队，别指望上层重试。
    const gap = BILI_MIN_GAP_MS + Math.floor(Math.random() * 600)
    const wait = lastRequestAt + gap - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastRequestAt = Date.now()
    const res = await getJson(`${baseUrl}?${signedQuery}`, { referer, signal, cookie: await buvidCookie({ signal }) })
    const verdict = biliVerdict(res.status, res.json, res.text)
    // 签名失效（-403）时重取一次 mixin_key，别让整批任务因为表换了直接死。
    if (verdict.kind === 'blocked' && retryOnSign && /-403|签名/.test(String(res.json?.message || ''))) {
      cachedKey = ''
      return signedGet(baseUrl, params, { referer, signal, retryOnSign: false })
    }
    return { ...res, verdict }
  }

  return {
    id: 'bilibili',
    label: 'B站',
    needsBrowser: false,
    // B站下载器自己要解析播放地址 + ffmpeg 合并，并发开大只会一起撞风控；2 路足够跑满带宽。
    maxConcurrency: 2,

    /** 作者入口不返回点赞，别按点赞筛，否则整批为空。 */
    supportsLikeFilter(source) {
      return source !== 'creator'
    },

    async openSession() {
      return null
    },

    async ensureLogin() {
      return { ok: true }
    },

    /**
     * 关键词搜索。cursor 是页码（从 1 开始）。
     */
    async searchKeyword(_session, { keyword, cursor = 1, signal, order = 'totalrank', sort = 'default' }) {
      const page = Math.max(1, Number(cursor) || 1)
      // 接口只认 totalrank（综合）/ click（播放）/ pubdate（最新）/ dm（弹幕）/ stow（收藏），没有点赞排序。
      // sort 是跨平台的统一口径：latest 映射到接口的 pubdate，most_liked 保持综合再由调度层页内按点赞降序。
      const useOrder = sort === 'latest' ? 'pubdate' : order || 'totalrank'
      const params = {
        search_type: 'video',
        keyword,
        page,
        page_size: 20,
        order: useOrder,
        platform: 'pc',
      }
      const res = await signedGet(SEARCH_URL, params, { referer: 'https://search.bilibili.com/', signal })
      if (res.verdict.kind !== 'ok') return { rows: [], nextCursor: '', verdict: res.verdict }
      const data = res.json?.data || {}
      const list = Array.isArray(data.result) ? data.result : []
      const numPages = Number(data.numPages) || 0
      const rows = list.map((item) => biliRow(item, { keyword, source: 'search' })).filter(Boolean)
      const hasMore = numPages > 0 ? page < numPages : rows.length > 0
      return {
        rows,
        nextCursor: hasMore ? String(page + 1) : '',
        total: Number(data.numResults) || 0,
        verdict: { kind: 'ok', message: '' },
      }
    },

    /**
     * 作者主页作品。cursor 是页码（从 1 开始），每页 30 条。
     */
    async listCreator(_session, { creatorId, cursor = 1, signal, order = 'pubdate' }) {
      const pn = Math.max(1, Number(cursor) || 1)
      const params = {
        mid: String(creatorId),
        ps: 30,
        tid: 0,
        pn,
        keyword: '',
        order: order || 'pubdate',
        platform: 'web',
        web_location: '1550101',
        order_avoided: 'true',
        ...BILI_DM_PARAMS,
      }
      const res = await signedGet(ARC_URL, params, {
        referer: `https://space.bilibili.com/${creatorId}/video`,
        signal,
      })
      if (res.verdict.kind !== 'ok') return { rows: [], nextCursor: '', verdict: res.verdict }
      const data = res.json?.data || {}
      const list = Array.isArray(data.list?.vlist) ? data.list.vlist : []
      const count = Number(data.page?.count) || 0
      const rows = list.map((item) => biliRow(item, { keyword: '', source: 'creator' })).filter(Boolean)
      const hasMore = count > 0 ? pn * 30 < count : rows.length >= 30
      return {
        rows,
        nextCursor: hasMore ? String(pn + 1) : '',
        total: count,
        authorName: rows[0]?.author || '',
        verdict: { kind: 'ok', message: '' },
      }
    },

    /** 能不能下这条：B站只要 bvid 就能现解析播放地址。 */
    canDownload(row) {
      return Boolean(row?.id)
    },

    fileName(row) {
      return `${String(row?.caption || row?.id || 'video').slice(0, 80)} [${row?.id}].mp4`
    },

    /** 复用插件已有的 B站单链下载（DASH 选流 + ffmpeg 合并）。 */
    async download(row, { dir, signal, quality: want } = {}) {
      if (typeof downloadBilibili !== 'function') {
        throw Object.assign(new Error('B站下载器未注入'), { code: 'missing_backend' })
      }
      const url = row.pageUrl || `https://www.bilibili.com/video/${row.id}`
      const out = await downloadBilibili(url, { outPath: dir, signal, quality: want || quality || 'best' })
      return { savedTo: out.savedTo, bytes: Number(out.bytes) || 0, quality: out.quality, muxed: out.muxed }
    },

    /** 由主页链接/BV/AV 号解析出 mid 或 bvid，交给 crawl 建任务。 */
    resolveCreatorId(input) {
      const text = String(input || '').trim()
      const space = text.match(/space\.bilibili\.com\/(\d+)/)
      if (space) return { creatorId: space[1], name: '' }
      if (/^\d{3,}$/.test(text)) return { creatorId: text, name: '' }
      return null
    },
  }
}
