/**
 * 快手搜索通道（无框架依赖，只碰 node 内建模块 + 全局 WebSocket）。
 *
 * 背景（2026-11-25 实测）：
 *   - GraphQL `visionSearchPhoto` 带登录态也返回 result:50，未签名通道已废弃。
 *   - headless 浏览器在页面层就被挡；必须用**有头** Edge + 持久 profile。
 *   - 唯一可用路径：有头页面里注入 caver 钩子拿到 `window.__ks_realm`，
 *     用 `$encode` 现算 `__NS_hxfalcon` 签名，再在页面上下文里 POST
 *     `/rest/v/search/feed?__NS_hxfalcon=<sign>&caver=2`，每页 20 条。
 *   - 搜索返回的 `photo.manifest.adaptationSet[].representation[]` 里是
 *     **单文件 mp4 直链**（不是 DASH，无需 ffmpeg 合并），CDN 免 cookie 免签名，
 *     Range 请求实测 206。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const KS_ORIGIN = 'https://www.kuaishou.com'
export const KS_FEED_PATH = '/rest/v/search/feed'
export const KS_SEARCH_PAGE_SIZE = 20

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 等价于 MediaCrawler 的签名环境捕获：劫持 Object.prototype.caver 的 setter，
 * 命中同时具备 $encode 与 $getCatVersion 的对象就存起来。
 */
export const KS_CAPTURE_SCRIPT = `
(() => {
  if (window.__ks_realm) return;
  let done = false;
  const setter = function (v) {
    if (!done && this && typeof this === 'object' && this !== window &&
        typeof this.$encode === 'function' && typeof this.$getCatVersion === 'function') {
      done = true;
      window.__ks_realm = this;
      try { delete Object.prototype.caver; } catch (e) {}
    }
    Object.defineProperty(this, 'caver', { value: v, writable: true, enumerable: true, configurable: true });
  };
  try { Object.defineProperty(Object.prototype, 'caver', { set: setter, configurable: true }); } catch (e) {}
})();
`

/** 搜一个词的结果该当成什么状态。纯函数，单测用。 */
export function kuaishouVerdict(result, errorMsg) {
  const n = Number(result)
  const msg = String(errorMsg || '')
  if (n === 1) return { kind: 'ok' }
  if (n === 2) return { kind: 'rate_limited', message: msg || '快手限流（result=2）' }
  if (n === 50) return { kind: 'need_login', message: '搜索需要签名或登录态已失效（result=50）' }
  if (n === 109) return { kind: 'need_login', message: '未登录（result=109）' }
  if (n === 400002) return { kind: 'captcha', message: msg || '快手风控（result=400002），需要人工处理验证码' }
  if (!Number.isFinite(n)) return { kind: 'failed', message: msg || '返回体无法解析' }
  return { kind: 'failed', message: msg || `未知返回码 ${n}` }
}

/** 播放列表地址（`.m3u8` 或带 hls 标记的）——这类地址直接落盘会得到一段文本，得走 ffmpeg 合并。 */
export function kuaishouIsHlsUrl(url) {
  return /\.m3u8(\?|#|$)/i.test(String(url || '')) || /[/_-]hls[/_-]/i.test(String(url || ''))
}

/**
 * 从一个 feed 里挑出可下载的直链。manifest 里可能有多个 adaptationSet
 * （不同清晰度/编码），这里挑体积最大的一条；返回 null 表示没有直链。
 *
 * 单文件 mp4 优先：HLS 播放列表还要再合并一道，能省就省；
 * 只有当所有变体都是 HLS 时才返回 HLS（`hls: true`），让下载层去做合并。
 */
export function kuaishouPickSource(photo) {
  const manifest = photo?.manifest
  if (!manifest || typeof manifest !== 'object') return null
  const sets = Array.isArray(manifest.adaptationSet) ? manifest.adaptationSet : []
  const candidates = []
  for (const set of sets) {
    const reps = Array.isArray(set?.representation) ? set.representation : []
    for (const rep of reps) {
      const url = typeof rep?.url === 'string' ? rep.url : ''
      if (!url.startsWith('http')) continue
      candidates.push({
        url,
        backupUrl: Array.isArray(rep.backupUrl) ? rep.backupUrl.filter((u) => typeof u === 'string' && u.startsWith('http')) : [],
        size: Number(rep.size) || 0,
        width: Number(rep.width) || 0,
        height: Number(rep.height) || 0,
        codecs: typeof rep.codecs === 'string' ? rep.codecs : '',
        hls: kuaishouIsHlsUrl(url),
      })
    }
  }
  if (!candidates.length) return null
  const direct = candidates.filter((c) => !c.hls)
  const pool = direct.length ? direct : candidates
  return pool.reduce((a, b) => (b.size > a.size ? b : a))
}

/** 把搜索响应里的 feeds 归一化成爬取任务要的行。纯函数。 */
export function kuaishouFeeds(payload) {
  const feeds = Array.isArray(payload?.feeds) ? payload.feeds : []
  const rows = []
  for (const feed of feeds) {
    const photo = feed?.photo
    const id = typeof photo?.id === 'string' ? photo.id : ''
    if (!id) continue
    const src = kuaishouPickSource(photo)
    // 快手 UI 上的「喜欢」就是这里的 likeCount；老数据/live 回包里可能只给别的别名，
    // 缺 likeCount 时按「点赞=喜欢」等价取第一个能用的数。
    const likeRaw = photo.likeCount ?? photo.realLikeCount ?? photo.likedCount ?? photo.like
    const viewRaw = photo.viewCount ?? photo.view ?? photo.playCount
    const tsRaw = Number(photo.timestamp ?? photo.createTime ?? 0) || 0
    rows.push({
      id,
      caption: typeof photo.caption === 'string' ? photo.caption : '',
      durationMs: Number(photo.duration) || 0,
      viewCount: Number(viewRaw) || 0,
      likeCount: Number(likeRaw) || 0,
      collectCount: Number(photo.collectCount) || 0,
      // 发布时间统一成毫秒：秒级时间戳（< 1e11）自动放大。
      timestampMs: tsRaw > 0 ? (tsRaw < 1e11 ? tsRaw * 1000 : tsRaw) : 0,
      author: typeof feed?.author?.name === 'string' ? feed.author.name : '',
      source: src,
    })
  }
  return rows
}

/** 文件名：标题前 40 字 + 视频 id，保证同目录内唯一且可读。 */
export function kuaishouFileName(caption, id) {
  // 快手文案常常整条都是 #话题，直接把 # 去掉、保留话题文字，比整段删掉信息量高得多。
  const cleaned = String(caption || '')
    .replace(/#/g, ' ')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  const base = cleaned || 'kuaishou'
  return `${base} [${id}].mp4`
}

function findBrowser() {
  return EDGE_CANDIDATES.find((p) => existsSync(p)) || ''
}

/**
 * 打开一个快手会话：有头浏览器 + 持久 profile（扫码一次长期有效，
 * 安全 cookie 的轮换由浏览器自己跟随）+ CDP。
 */
export async function openKuaishouSession({ profileDir, log = () => {}, signal, port = 9415 } = {}) {
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
  const close = () => {
    if (closed) return
    closed = true
    try { ws?.close() } catch {}
    try { child.kill() } catch {}
  }

  let ws = null
  try {
    let wsUrl = ''
    for (let i = 0; i < 80; i++) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'canceled' })
      await sleep(250)
      if (child.exitCode !== null) throw Object.assign(new Error('浏览器启动后立刻退出'), { code: 'browser_failed' })
      try {
        const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
        if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break }
      } catch {}
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
        } catch {
          resolve(null)
        }
        setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); resolve(null) } }, 45000)
      })
    }

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    if (!targetId) throw Object.assign(new Error('无法新建标签页'), { code: 'cdp_unavailable' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('Network.enable', {}, sessionId)
    await send('Page.addScriptToEvaluateOnNewDocument', { source: KS_CAPTURE_SCRIPT }, sessionId)

    const evalP = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      return r?.result?.value
    }
    const hasRealm = async () => (await evalP('!!window.__ks_realm')) === true

    log('打开快手首页…')
    await send('Page.navigate', { url: `${KS_ORIGIN}/` }, sessionId)
    await sleep(6000)
    if (!(await hasRealm())) {
      log('签名环境未就绪，重载一次…')
      await send('Page.reload', {}, sessionId)
      await sleep(7000)
    }
    const realm = await hasRealm()
    log(realm ? '签名环境已捕获' : '签名环境捕获失败')

    const readCookies = async () => {
      const j = await send('Network.getAllCookies', {}, sessionId)
      const map = new Map()
      for (const c of j?.cookies || []) if (/kuaishou/.test(String(c.domain))) map.set(c.name, c.value)
      return map
    }

    const searchOnce = async ({ keyword, pcursor = '', searchSessionId = '' }) => {
      const script = `(async () => {
        const body = { keyword: ${JSON.stringify(String(keyword))}, pcursor: ${JSON.stringify(String(pcursor || ''))},
                       page: 'search', searchSessionId: ${JSON.stringify(String(searchSessionId || ''))} };
        if (!window.__ks_realm) return JSON.stringify({ __noRealm: true });
        const sign = await new Promise((resolve, reject) => {
          window.__ks_realm.call('$encode', [
            { url: '${KS_FEED_PATH}', query: { caver: 2 }, form: {}, requestBody: body },
            { suc: (s) => resolve(s), err: (e) => reject(new Error(String(e))) }
          ]);
        });
        const res = await fetch('${KS_FEED_PATH}?__NS_hxfalcon=' + sign + '&caver=2', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body), credentials: 'include'
        });
        const text = await res.text();
        try { return text; } catch (e) { return JSON.stringify({ __parseFailed: true }); }
      })()`
      const out = await evalP(script)
      if (typeof out !== 'string') return { __transport: 'evaluate_failed' }
      try {
        return JSON.parse(out)
      } catch {
        return { __transport: 'not_json', raw: String(out).slice(0, 300) }
      }
    }

    return {
      browserPath: bin,
      profileDir,
      hasRealm: realm,
      searchOnce,
      readCookies,
      hasLogin: async () => {
        const cookies = await readCookies()
        return Boolean(cookies.get('userId'))
      },
      screenshot: async (file) => {
        const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
        if (r?.data) {
          mkdirSync(join(file, '..'), { recursive: true })
          writeFileSync(file, Buffer.from(r.data, 'base64'))
          return file
        }
        return ''
      },
      navigate: (url) => send('Page.navigate', { url }, sessionId),
      close,
    }
  } catch (err) {
    close()
    throw err
  }
}
