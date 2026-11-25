/**
 * 抖音通道：不移植 a_bogus。
 *
 * 做法跟 CreatorHub 一致——打开 douyin.com 的页面，在**页面内** fetch 官方接口，
 * 让抖音自己的 SecSDK 往请求上追加 a_bogus / msToken 这类随版本变的安全字段。
 * 我们只负责参数与解码，不碰签名算法（算法一变就得跟着改，维护成本极高）。
 *
 * 两个接口：
 *   搜索   GET /aweme/v1/web/general/search/stream/   ← 返回是 chunked JSON 流
 *   作者作品 GET /aweme/v1/web/aweme/post/            ← 普通 JSON
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const DOUYIN_ORIGIN = 'https://www.douyin.com'
const WARM_URL = 'https://www.douyin.com/jingxuan'
const SEARCH_PATH = '/aweme/v1/web/general/search/stream/'
const POST_PATH = '/aweme/v1/web/aweme/post/'
const SEARCH_PAGE_SIZE = 10 // 官方首页固定 10，传大了也不生效

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/* ------------------------------------------------------------------ 纯函数 */

/**
 * 抖音搜索流是 HTTP chunked 帧：`<hex 字节数>\r\n<json>` 重复，0 结束。
 * 必须按 **字节** 切——中文一个字符占 3 字节，用字符串下标会错位（踩过）。
 */
export function decodeDouyinPayloads(raw) {
  const buf = Buffer.from(String(raw || ''), 'utf8')
  if (!buf.length) return []
  try {
    const one = JSON.parse(buf.toString('utf8'))
    return one && typeof one === 'object' ? [one] : []
  } catch { /* 不是单块 JSON，走帧解析 */ }
  const out = []
  let pos = 0
  while (pos < buf.length) {
    const eol = buf.indexOf('\r\n', pos, 'latin1')
    if (eol < 0) return out
    const sizeText = buf.toString('latin1', pos, eol).split(';')[0].trim()
    const size = Number.parseInt(sizeText, 16)
    if (!Number.isFinite(size)) return out
    pos = eol + 2
    if (size === 0) break
    const chunkEnd = pos + size
    if (chunkEnd > buf.length) return out
    try {
      const payload = JSON.parse(buf.toString('utf8', pos, chunkEnd))
      if (payload && typeof payload === 'object') out.push(payload)
    } catch { /* 单帧坏了不影响其它帧 */ }
    pos = chunkEnd
    if (buf.toString('latin1', pos, pos + 2) === '\r\n') pos += 2
  }
  return out
}

/** 从不同版本的容器里挖出作品对象，只认带 aweme_id 且有 video/images 的。 */
export function douyinExtractAwemes(payload) {
  const found = new Map()
  const CONTAINERS = ['data', 'items', 'list', 'aweme_list', 'aweme_info', 'aweme_mix_info', 'mix_items', 'search_result', 'card']
  const visit = (v) => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return }
    if (!v || typeof v !== 'object') return
    const id = String(v.aweme_id || '')
    if (id && (v.video || v.images)) { if (!found.has(id)) found.set(id, v); return }
    for (const k of CONTAINERS) { const c = v[k]; if (c && c !== v) visit(c) }
  }
  visit(payload)
  return [...found.values()]
}

/**
 * 把一帧的返回码翻成人话。抖音把「没登录」和「要验证」都塞在 status_code / status_msg /
 * search_nil_info 里，必须分开——前者等用户扫码，后者等用户过验证，处置完全不同。
 */
export function douyinVerdict(payload) {
  if (!payload || typeof payload !== 'object') return { kind: 'failed', message: '返回不是对象' }
  const code = payload.status_code
  const msg = String(payload.status_msg || payload.message || '')
  if (code !== undefined && code !== null && String(code) !== '0') {
    const lower = msg.toLowerCase()
    if (['8', '2483'].includes(String(code)) || /未登录|登录后|login/.test(lower)) {
      return { kind: 'need_login', message: msg || '需要登录' }
    }
    if (/verify|captcha|risk|验证|风控/.test(lower)) return { kind: 'captcha', message: msg || '需要过验证' }
    if (['2154', '10000'].includes(String(code))) return { kind: 'rate_limited', message: msg || '请求过于频繁' }
    return { kind: 'blocked', message: `返回码 ${code}：${msg}` }
  }
  const nil = payload.search_nil_info || {}
  const marker = [nil.search_nil_type, nil.search_nil_item, nil.text_type].map((x) => String(x || '')).join(' ').toLowerCase()
  if (/verify|captcha|risk/.test(marker)) return { kind: 'captcha', message: '需要过验证' }
  return { kind: 'ok', message: '' }
}

/** 一帧里的翻页游标与 has_more。 */
export function douyinPageState(payload) {
  let hasMore = false
  let next = 0
  let searchId = ''
  if (!payload || typeof payload !== 'object') return { hasMore, next, searchId }
  if (payload.has_more || payload.has_more_item) hasMore = true
  for (const k of ['cursor', 'offset', 'next_offset']) {
    const v = payload[k]
    if (v === undefined || v === null || typeof v === 'boolean') continue
    const n = Number(v) || 0
    if (n > next) next = n
  }
  searchId = String((payload.extra || {}).logid || (payload.log_pb || {}).impr_id || payload.search_id || '')
  return { hasMore, next, searchId }
}

/** 作品对象 → 调度层认的行。缺字段标 undefined，不补 0。 */
export function douyinRow(aweme, { source = 'search' } = {}) {
  if (!aweme || typeof aweme !== 'object') return null
  const id = String(aweme.aweme_id || '')
  if (!id) return null
  const video = aweme.video || {}
  const play = video.play_addr || {}
  const urls = Array.isArray(play.url_list) ? play.url_list.filter(Boolean).map(String) : []
  // play_addr 里会混进音乐/封面等静态资源（douyinstatic 的 obj/ies-m、tos-cn-ve-*），
  // 照着下会存出一个不是视频的文件——实测踩过，所以只认真正的视频 CDN。
  const isVideoUrl = (u) =>
    /douyinvod\.com\//i.test(u) || /\/video\/tos\//i.test(u) || /\.mp4(\?|#|$)/i.test(u)
  const videoUrls = urls.filter(isVideoUrl)
  const images = Array.isArray(aweme.images) ? aweme.images.filter(Boolean) : []
  const stat = aweme.statistics || {}
  const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v))
  const pos = (v) => {
    const n = num(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const created = num(aweme.create_time)
  return {
    id,
    caption: String(aweme.desc || '').trim(),
    author: String((aweme.author || {}).nickname || '').trim(),
    authorId: String((aweme.author || {}).sec_uid || '').trim(),
    // 搜索与作者作品都带 statistics.digg_count；拿不到就保持 undefined，绝不补 0
    likeCount: num(stat.digg_count),
    // 搜索结果实测恒为 play_count=0（接口不给播放量），0 当「未知」而不是「没人看」
    viewCount: pos(stat.play_count),
    commentCount: num(stat.comment_count),
    timestampMs: created ? created * 1000 : undefined,
    durationMs: num(video.duration),
    source: {
      url: videoUrls[0] || '',
      backupUrl: videoUrls.slice(1),
      kind: videoUrls.length ? 'direct' : images.length ? 'images' : 'missing',
    },
    rawSource: source,
  }
}

export function douyinFileName(caption, id) {
  const cleaned = String(caption || '')
    .replace(/#/g, ' ')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return `${cleaned || 'douyin'} [${id}].mp4`
}

/** 认 `douyin.com/user/<sec_uid>`、`v.douyin.com/xxx` 之外的纯 sec_uid。 */
export function douyinResolveCreatorId(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const m = raw.match(/douyin\.com\/user\/([A-Za-z0-9_\-]+)/)
  if (m) return { creatorId: m[1], name: '' }
  if (/^MS4wLjABAAAA[A-Za-z0-9_\-]+$/.test(raw)) return { creatorId: raw, name: '' }
  if (/^[A-Za-z0-9_\-]{20,}$/.test(raw)) return { creatorId: raw, name: '' }
  return null
}

/* ------------------------------------------------------------------ 会话 */

function findBrowser() {
  return EDGE_CANDIDATES.find((p) => existsSync(p)) || ''
}

/**
 * 打开抖音会话：有头浏览器 + 持久 profile（扫码一次长期有效）+ CDP。
 * 页面内 fetch 由抖音自己的运行时补签，所以这里不需要注入任何签名钩子。
 */
export async function openDouyinSession({ profileDir, log = () => {}, signal, port = 9417, blockMedia = false } = {}) {
  const bin = findBrowser()
  if (!bin) throw Object.assign(new Error('没有找到 Edge/Chrome，无法走浏览器通道'), { code: 'browser_missing' })
  mkdirSync(profileDir, { recursive: true })

  const child = spawn(bin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let closed = false
  let ws = null
  const close = () => {
    if (closed) return
    closed = true
    try { ws?.close() } catch {}
    try { child.kill() } catch {}
  }

  try {
    let wsUrl = ''
    for (let i = 0; i < 80; i++) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'canceled' })
      await sleep(250)
      if (child.exitCode !== null) throw Object.assign(new Error('浏览器启动后立刻退出'), { code: 'browser_failed' })
      try {
        const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
        if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break }
      } catch { /* 还没起来 */ }
    }
    if (!wsUrl) throw Object.assign(new Error('调试端口没起来（可能已有同 profile 的浏览器在跑）'), { code: 'cdp_unavailable' })

    ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连接失败')) })

    let seq = 0
    const waiters = new Map()
    ws.onmessage = (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result ?? m.error ?? null); waiters.delete(m.id) }
    }
    const send = (method, params = {}, sessionId) => {
      const id = ++seq
      return new Promise((resolve) => {
        waiters.set(id, resolve)
        try {
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        } catch { resolve(null) }
        setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); resolve(null) } }, 60000)
      })
    }

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    if (!targetId) throw Object.assign(new Error('无法新建标签页'), { code: 'cdp_unavailable' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('Network.enable', {}, sessionId)
    // 注意：抖音是 SPA，屏蔽图片/视频请求会打断首屏渲染、导致拿不到数据，所以这里默认关。
    if (blockMedia) {
      await send('Network.setBlockedURLs', {
        urls: ['*.png', '*.jpg', '*.jpeg', '*.webp', '*.gif', '*.woff', '*.woff2', '*.ttf'],
      }, sessionId)
    }

    const evalP = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      if (r?.exceptionDetails) return { __error: String(r.exceptionDetails.text || '') + ' ' + String(r.exceptionDetails.exception?.description || '') }
      return r?.result?.value
    }

    log('打开抖音首页…')
    await send('Page.navigate', { url: WARM_URL }, sessionId)
    await sleep(6000)

    const ua = String((await evalP('navigator.userAgent')) || '')
    const chromeVer = (ua.match(/Chrome\/(\d+)/) || [, '131'])[1]
    const winVer = (ua.match(/Windows NT (\d+)/) || [, '10'])[1]

    const readCookies = async () => {
      const j = await send('Network.getAllCookies', {}, sessionId)
      const map = new Map()
      for (const c of j?.cookies || []) if (/douyin/.test(String(c.domain))) map.set(c.name, c.value)
      return map
    }
    const hasLogin = async () => [...(await readCookies()).keys()].some((k) => /^sessionid(_ss)?$/.test(k))

    const screenshot = async (file) => {
      try {
        const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
        if (r?.data) { mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true }); writeFileSync(file, Buffer.from(r.data, 'base64')) }
      } catch { /* 截图失败不影响主流程 */ }
    }

    /** 页面内 fetch：同源、带 cookie，安全字段由抖音运行时补。 */
    const fetchInPage = async (path, params) => {
      const out = await evalP(`(async () => {
        const input = ${JSON.stringify({ path, params })};
        const q = new URLSearchParams({
          ...input.params,
          browser_version: ${JSON.stringify(chromeVer)} + '.0.0.0',
          engine_version: ${JSON.stringify(chromeVer)} + '.0.0.0',
          cpu_core_num: String(navigator.hardwareConcurrency || 8),
          device_memory: String(navigator.deviceMemory || 8),
        });
        const r = await fetch(input.path + '?' + q.toString(), {
          method:'GET', credentials:'include',
          headers:{Accept:'application/json, text/plain, */*'},
        });
        return { status: r.status, text: await r.text() };
      })()`)
      if (out?.__error) return { ok: false, verdict: { kind: 'failed', message: out.__error.slice(0, 200) } }
      if (Number(out?.status || 0) !== 200) {
        const code = Number(out?.status || 0)
        const kind = code === 403 || code === 429 ? 'blocked'
          : code === 401 ? 'need_login'
          : code >= 500 ? 'blocked' : 'failed'
        return { ok: false, verdict: { kind, message: `HTTP ${code}` } }
      }
      return { ok: true, text: String(out?.text || '') }
    }

    /** 搜索一页。cursor 是 offset。 */
    const searchOnce = async ({ keyword, cursor = '', sessionId: sid = '' }) => {
      const offset = Number(cursor) || 0
      const params = {
        device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1',
        version_code: '190600', version_name: '19.6.0', cookie_enabled: 'true',
        browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Edge', browser_online: 'true',
        engine_name: 'Blink', os_name: 'Windows', os_version: winVer, platform: 'PC',
        downlink: '10', effective_type: '4g', round_trip_time: '150',
        keyword, search_channel: 'aweme_general', search_source: 'normal_search',
        query_correct_type: '1', is_filter_search: '0', offset: String(offset), count: String(SEARCH_PAGE_SIZE),
        list_type: 'single', search_id: sid, need_filter_settings: offset === 0 ? '1' : '0',
        enable_history: '1', disable_rs: '0', from_group_id: '', pc_libra_divert: 'Windows',
        pc_search_top_1_params: '{"enable_ai_search_top_1":1}', support_h265: '0', support_dash: '1',
        update_version_code: '0',
      }
      const cm = await readCookies()
      if (cm.get('dy_swidth')) params.screen_width = cm.get('dy_swidth')
      if (cm.get('dy_sheight')) params.screen_height = cm.get('dy_sheight')
      const res = await fetchInPage(SEARCH_PATH, params)
      if (!res.ok) return { verdict: res.verdict, rows: [], cursor: '', hasMore: false }
      const payloads = decodeDouyinPayloads(res.text)
      if (!payloads.length) return { verdict: { kind: 'failed', message: '搜索流解不出内容（接口结构可能变了）' }, rows: [], cursor: '', hasMore: false }
      const rows = []
      let verdict = { kind: 'ok', message: '' }
      let hasMore = false
      let nextCursor = ''
      let nextSearchId = sid
      for (const p of payloads) {
        const v = douyinVerdict(p)
        if (v.kind !== 'ok') { verdict = v; break }
        const st = douyinPageState(p)
        if (st.hasMore) hasMore = true
        if (st.next > (Number(nextCursor) || 0)) nextCursor = String(st.next)
        if (st.searchId) nextSearchId = st.searchId
        for (const aweme of douyinExtractAwemes(p)) {
          const row = douyinRow(aweme, { source: 'search' })
          if (row) rows.push(row)
        }
      }
      // 翻页靠 offset 递增：接口给的空游标很常见，用本页条数兜底
      if (hasMore && !nextCursor) nextCursor = String(offset + Math.max(rows.length, SEARCH_PAGE_SIZE))
      return { verdict, rows, cursor: nextCursor, hasMore, searchSessionId: nextSearchId }
    }

    /** 作者作品一页。cursor 是 max_cursor。 */
    const profileOnce = async ({ secUserId, cursor = '' }) => {
      const params = {
        device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1',
        version_code: '190600', version_name: '19.6.0', cookie_enabled: 'true',
        browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Edge', browser_online: 'true',
        engine_name: 'Blink', os_name: 'Windows', os_version: winVer, platform: 'PC',
        downlink: '10', effective_type: '4g', round_trip_time: '150',
        sec_user_id: secUserId,
        max_cursor: String(Number(cursor) || 0),
        count: '20',
        publish_video_strategy_type: '2',
        update_version_code: '0',
      }
      const res = await fetchInPage(POST_PATH, params)
      if (!res.ok) return { verdict: res.verdict, rows: [], cursor: '', hasMore: false }
      let payload = null
      try { payload = JSON.parse(res.text) } catch { /* 偶尔也走 chunked 帧 */ }
      const list = payload ? [payload] : decodeDouyinPayloads(res.text)
      if (!list.length) return { verdict: { kind: 'failed', message: '作者作品解不出内容' }, rows: [], cursor: '', hasMore: false }
      const rows = []
      let verdict = { kind: 'ok', message: '' }
      let hasMore = false
      let nextCursor = ''
      for (const p of list) {
        const v = douyinVerdict(p)
        if (v.kind !== 'ok') { verdict = v; break }
        if (p.has_more) hasMore = true
        if (p.max_cursor !== undefined && Number(p.max_cursor) > (Number(nextCursor) || 0)) nextCursor = String(p.max_cursor)
        for (const aweme of Array.isArray(p.aweme_list) ? p.aweme_list : douyinExtractAwemes(p)) {
          const row = douyinRow(aweme, { source: 'creator' })
          if (row) rows.push(row)
        }
      }
      return { verdict, rows, cursor: nextCursor, hasMore }
    }

    return {
      browserPath: bin,
      profileDir,
      origin: DOUYIN_ORIGIN,
      searchOnce,
      profileOnce,
      readCookies,
      hasLogin,
      screenshot,
      fetchInPage,
      /** 页面内执行一段 JS（取 DOM 文本用），失败返回 undefined。 */
      evaluate: evalP,
      /**
       * 换到另一个抖音页面再操作。实测 `/aweme/v1/web/user/profile/self/` 只在
       * `https://www.douyin.com/user/self` 这一页能认登录态（在 jingxuan 下返回
       * status_code 8「用户未登录」），所以取昵称前要先导航过去。
       */
      goto: async (url, waitMs = 2500) => {
        await send('Page.navigate', { url }, sessionId)
        await sleep(waitMs)
      },
      close,
    }
  } catch (e) {
    close()
    throw e
  }
}

/* ------------------------------------------------------------------ 适配器 */

export function createDouyinAdapter() {
  return {
    id: 'douyin',
    label: '抖音',
    needsBrowser: true,
    maxConcurrency: 3,
    // 作者作品接口同样带 statistics.digg_count，点赞筛选两个入口都能用
    supportsLikeFilter: () => true,
    profileDir: (stateDir) => `${stateDir}/douyin/profile`,

    async openSession({ stateDir, log, signal, blockMedia = false } = {}) {
      return openDouyinSession({ profileDir: `${stateDir}/douyin/profile`, log, signal, blockMedia })
    },

    /** 没有登录态就没法搜索（接口直接回 2483），所以这里必须等用户扫码。 */
    async ensureLogin(session, { stateDir, jobId, log = () => {}, signal, onNeedHuman, waitMs = 180000 } = {}) {
      if (await session.hasLogin()) return { ok: true, loggedIn: true }
      const shot = `${stateDir}/douyin-${jobId || 'login'}.png`
      log('抖音未登录：需要扫码（搜索接口未登录直接拒绝）')
      try { await session.screenshot(shot) } catch {}
      try { onNeedHuman?.({ reason: 'login', message: '抖音需要扫码登录', screenshot: shot }) } catch {}
      const budget = Math.max(30000, Number(waitMs) || 180000)
      const deadline = Date.now() + budget
      while (Date.now() < deadline) {
        if (signal?.aborted) return { ok: false, reason: 'canceled', message: '已取消' }
        await sleep(3000)
        if (await session.hasLogin()) { log('抖音登录态已就绪'); return { ok: true, loggedIn: true } }
      }
      return { ok: false, reason: 'need_login', message: `抖音登录超时（${Math.round(budget / 1000)} 秒）：请在弹出的浏览器里扫码后 resume`, screenshot: shot }
    },

    async searchKeyword(session, { keyword, cursor = '', sessionId = '' } = {}) {
      const r = await session.searchOnce({ keyword, cursor, sessionId })
      return {
        verdict: r.verdict,
        rows: r.rows,
        cursor: r.cursor,
        hasMore: r.hasMore,
        searchSessionId: r.searchSessionId || sessionId,
        authorName: r.rows[0]?.author || '',
      }
    },

    async listCreator(session, { creatorId, cursor = '' } = {}) {
      const r = await session.profileOnce({ secUserId: creatorId, cursor })
      return {
        verdict: r.verdict,
        rows: r.rows,
        cursor: r.cursor,
        hasMore: r.hasMore,
        authorName: r.rows[0]?.author || '',
      }
    },

    /**
     * 登录态下取自己的昵称，供设置页「账号」栏显示。
     * 实测 `/aweme/v1/web/user/profile/self/` 即使带着有效 sessionid 也回
     * status_code 8「用户未登录」（该接口要页面签名），所以走 `/user/self` 页面的 DOM，
     * `h1` 就是昵称。抖音号（`[data-e2e="user-info"]`）在 textContent 里与「N岁/关注/粉丝」
     * 拼在一起、位数不固定，取出来会多一两位，所以 id 改用 cookie 里的 uid_tt。
     */
    async account(session) {
      try {
        if (session?.goto) await session.goto('https://www.douyin.com/user/self', 2500)
        const probe = `(() => {
          const name = (document.querySelector('h1')?.textContent || '').trim()
            || String(document.title || '').replace(/的抖音.*$/, '');
          return JSON.stringify({ name });
        })()`
        // 页面渲染快慢不定，轮询到昵称出来为止（最多约 15 秒）
        let name = ''
        for (let i = 0; i < 10; i++) {
          const raw = await session?.evaluate?.(probe)
          if (typeof raw === 'string' && raw.trim().startsWith('{')) {
            try {
              const parsed = JSON.parse(raw)
              const got = String(parsed?.name || '').trim()
              if (got) {
                name = got
                break
              }
            } catch {
              /* 还没渲染好，继续等 */
            }
          }
          await new Promise((r) => setTimeout(r, 1500))
        }
        if (!name) return null
        let id = ''
        try {
          const jar = await session?.readCookies?.()
          const find = (k) => ((Array.isArray(jar) ? jar : []).find((c) => c?.name === k)?.value || '')
          id = find('uid_tt') || find('uid_tt_ss') || ''
        } catch {
          /* 拿不到 uid 就只显示昵称 */
        }
        return { name, id }
      } catch {
        return null
      }
    },

    canDownload(row) {
      return Boolean(row?.source?.url)
    },

    // 抖音搜索接口不给播放量（play_count 恒 0），按播放量筛只会把整批筛空 → 声明不支持
    supportsViewFilter() {
      return false
    },

    fileName(row) {
      return douyinFileName(row?.caption, row?.id)
    },

    resolveCreatorId(input) {
      return douyinResolveCreatorId(input)
    },
  }
}
