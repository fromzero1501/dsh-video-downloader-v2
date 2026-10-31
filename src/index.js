/**
 * dsh-video-downloader — media downloader for DeepSeek Harness (DSH 0.2.x).
 *
 * Two layers:
 *
 *   pure core  — URL classification / quality parsing / Bilibili payload parsing,
 *                no I/O. Everything here is exported and unit-tested.
 *   tool layer — four agent-callable tools registered on `ctx.tools`:
 *
 *     video_analyze        classify a URL (media? page? which site? quality? ext?)
 *     video_resolve        page URL -> real media streams (Bilibili built-in, others via yt-dlp)
 *     video_download       direct media URL, a Bilibili page URL, or any yt-dlp-supported page -> file on disk
 *     video_quality_parse  pure regex quality/extension extraction
 *
 * The plugin depends on no kernel package at import time: profile bundles are
 * resolved outside the host's kernel package tree, so `@deepseek-ai/dsh-tools`
 * is not importable from here (shipped plugins never import it either). The
 * declarative parameter DSL is therefore compiled locally into plain JSON
 * Schema, which is exactly what `ctx.tools.register()` consumes.
 */

import { createWriteStream, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { renameSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { Readable } from 'node:stream'
import { homedir, tmpdir } from 'node:os'

export const name = 'dsh-video-downloader'
export const inject = ['tools']

// ---------------------------------------------------------------- constants

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const BILI_REFERER = 'https://www.bilibili.com/'
const MAX_REDIRECTS = 5
const IDLE_TIMEOUT_MS = 60_000

// ------------------------------------------------------------ tool helper
// Local stand-in for `defineTool` from @deepseek-ai/dsh-tools: same declarative
// parameter DSL in, plain JSON Schema out. `ctx.tools.register()` only needs
// { name, description, parameters, output, execute } and validates the output
// schema itself, so no kernel module has to be resolvable at import time.

const SPEC_KEYS = ['type', 'title', 'description', 'default', 'examples', 'enum']

function compileNode(node) {
  if (node === null || typeof node !== 'object') return { type: 'string' }
  const out = {}
  for (const key of SPEC_KEYS) if (node[key] !== undefined) out[key] = node[key]
  if (node.type === 'object') {
    const properties = {}
    const required = []
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      properties[key] = compileNode(value)
      if (value?.required === true) required.push(key)
    }
    out.type = 'object'
    if (Object.keys(properties).length > 0) out.properties = properties
    if (required.length > 0) out.required = required
    if (typeof node.additionalProperties === 'boolean') out.additionalProperties = node.additionalProperties
  } else if (node.type === 'array') {
    out.type = 'array'
    out.items = compileNode(node.items ?? { type: 'string' })
  } else {
    out.type = node.type ?? 'string'
  }
  return out
}

function compileParameters(spec) {
  return compileNode({ type: 'object', properties: spec ?? {} })
}

function defineTool(options) {
  const definition = {
    name: options.name,
    description: options.description,
    parameters: compileParameters(options.parameters),
    output: options.output,
    async execute(args, exec) {
      return options.execute(args ?? {}, exec)
    },
  }
  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs
  return definition
}

// Media heuristics lifted from video-downloader-extension/background.js.
const MEDIA_EXT = /\.(mp4|m3u8|flv|webm|mkv|avi|mov|ts|f4v|mpd|m4s|mp3|wav|aac|ogg|opus|flac)(\?[^]*)?$/i
const MEDIA_URL = /videoplayback|manifest\.(mpd|m3u8)|\/flv\/|\.m3u8|\.mp4|bilivideo\.com|googlevideo\.com|xvideos\.com|pornhub\.com/i
const MEDIA_CT = /^video\/|^audio\/|application\/x-mpegURL|application\/dash\+xml|application\/vnd\.apple\.mpegurl|octet-stream/i

// Bilibili DASH quality-id -> label map (background.js QUALITY_MAP).
const QUALITY_MAP = {
  127: '8K', 126: 'Dolby Atmos', 125: 'HDR', 120: '4K',
  116: '1080P60', 112: '1080P高码率', 80: '1080P', 74: '720P60',
  64: '720P', 48: '720P', 32: '480P', 16: '360P',
}

// Bilibili playurl uses the same qn ids as the DASH video ids above.
const BILI_QUALITY = QUALITY_MAP

const EXT_MIME = {
  mp4: 'video/mp4', m3u8: 'application/x-mpegURL', mpd: 'application/dash+xml',
  flv: 'video/x-flv', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', mov: 'video/quicktime', ts: 'video/mp2t',
  f4v: 'video/x-f4v', m4s: 'video/iso.segment',
  mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg',
  opus: 'audio/ogg', flac: 'audio/flac',
}

const mimeHintOf = (ext) => EXT_MIME[ext] || 'application/octet-stream'

// ---------------------------------------------------------------- pure core

/** True when the URL (and optional content-type) looks like downloadable media. */
export function isMedia(url, ct) {
  if (ct && MEDIA_CT.test(ct)) return true
  if (MEDIA_EXT.test(url)) return true
  if (MEDIA_URL.test(url)) return true
  return false
}

/**
 * Best-effort quality label from a URL: WxH dimensions, height/h/quality
 * query params, bitrate thresholds, then raw keyword matches and container.
 */
export function getQuality(url) {
  let m = url.match(/(\d{3,4})x(\d{3,4})/)
  if (m) return m[2] + 'P'
  m = url.match(/[?&](height|h|resolution|quality)=(\d{3,4})/i)
  if (m) return m[2] + 'P'
  m = url.match(/[?&](bitrate|br)=(\d+)/i)
  if (m) {
    // 有的 CDN（抖音 douyinvod 就是）按 kbps 给码率，不足 100000 时按 kbps 还原
    let br = parseInt(m[2], 10)
    if (br < 100000) br *= 1000
    if (br > 8000000) return '4K'
    if (br > 5000000) return '1080P'
    if (br > 2000000) return '720P'
    if (br > 800000) return '480P'
    return '360P'
  }
  if (/2160|4k/i.test(url)) return '4K'
  if (/1080/i.test(url)) return '1080P'
  if (/720/i.test(url)) return '720P'
  if (/480/i.test(url)) return '480P'
  if (/360/i.test(url)) return '360P'
  if (url.includes('.m3u8')) return 'HLS'
  if (url.includes('.mpd')) return 'DASH'
  if (url.includes('.m4s')) return 'M4S'
  if (url.includes('.flv')) return 'FLV'
  return ''
}

/** Container extension for a URL (optionally refined by content-type). */
export function getExt(url, ct) {
  if (url.includes('.m3u8')) return 'm3u8'
  if (url.includes('.mpd')) return 'mpd'
  if (url.includes('.flv')) return 'flv'
  if (url.includes('.m4s')) return 'm4s'
  if (url.includes('.ts')) return 'ts'
  if (ct && ct.includes('webm')) return 'webm'
  return 'mp4'
}

/** Which supported site a URL belongs to (by hostname). */
export function detectSite(url) {
  let hostname = ''
  try {
    hostname = new URL(url).hostname
  } catch {
    hostname = String(url).split(/[/?#]/)[0]
  }
  if (hostname.includes('bilibili.com') || hostname === 'b23.tv') return 'bilibili'
  if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) return 'youtube'
  if (hostname.includes('douyin.com') || hostname.includes('iesdouyin.com')) return 'douyin'
  if (hostname.includes('xiaohongshu.com') || hostname.includes('xhslink.com')) return 'xiaohongshu'
  return 'other'
}

/** Bilibili video id out of a BV id, a video page URL or a short link. */
export function extractBvid(input) {
  const s = String(input)
  const direct = s.match(/BV[0-9A-Za-z]{10}/)
  return direct ? direct[0] : ''
}

/** `?p=N` page number of a Bilibili video URL (1 when absent). */
export function extractPage(input) {
  try {
    const p = new URL(String(input)).searchParams.get('p')
    const n = parseInt(p || '1', 10)
    return Number.isFinite(n) && n > 0 ? n : 1
  } catch {
    return 1
  }
}

/**
 * Nineteen-digit Douyin aweme id out of any shape Douyin hands out: a bare id,
 * `?modal_id=` on a profile page, `/video/<id>`, `/share/video/<id>`, a note,
 * or a share sentence with the link pasted inside it.
 */
export function douyinVideoId(input) {
  const s = String(input ?? '').trim()
  if (!s) return ''
  if (/^\d{19}$/.test(s)) return s
  const q = s.match(/[?&#](?:modal_id|vid|aweme_id|item_id)=(\d{15,20})/i)
  if (q) return q[1]
  const p = s.match(/\/(?:share\/)?(?:video|note|slides?)\/(\d{15,20})/)
  if (p) return p[1]
  const any = s.match(/(?:^|\D)(\d{19})(?:\D|$)/)
  return any ? any[1] : ''
}

/** Canonical Douyin video page for any shareable Douyin shape (unchanged when none). */
export function normalizeDouyinUrl(input) {
  const s = String(input ?? '').trim()
  if (!s) return ''
  if (detectSite(s) !== 'douyin') return s
  const id = douyinVideoId(s)
  return id ? `https://www.douyin.com/video/${id}` : s
}

/** A playlist URL is not a file: streaming it would only save the playlist text. */
export function isPlaylistUrl(url) {
  const ext = getExt(url)
  return ext === 'm3u8' || ext === 'mpd'
}

/**
 * True when the input addresses a page that still has to be resolved into
 * media streams (Bilibili video page / short link / bare BV id).
 */
export function isResolvablePage(input) {
  const s = String(input).trim()
  if (!s) return false
  if (/^BV[0-9A-Za-z]{10}$/.test(s)) return true
  if (!/^https?:\/\//i.test(s)) return false
  try {
    const u = new URL(s)
    if (u.hostname === 'b23.tv') return true
    if (!u.hostname.includes('bilibili.com')) return false
    return /\/video\/BV[0-9A-Za-z]{10}/.test(u.pathname) || /\/video\/av\d+/i.test(u.pathname)
  } catch {
    return false
  }
}

/** Which engine should handle this input: bilibili | direct | ytdlp | unsupported | none. */
export function routeFor(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return 'none'
  const s = normalizeDouyinUrl(raw)
  if (isResolvablePage(s)) return 'bilibili'
  if (isMedia(s)) return isPlaylistUrl(s) ? 'ytdlp' : 'direct'
  if (!/^https?:\/\//i.test(s)) return 'none'
  if (detectSite(s) === 'bilibili') return 'unsupported'
  return 'ytdlp'
}

/** One-line classification used by `video_analyze`. */
export function analyze(url) {
  const u = String(url)
  const ext = getExt(u)
  const site = detectSite(u)
  const backend = routeFor(u)
  const isPage = backend === 'bilibili' || backend === 'ytdlp'
  const normalized = normalizeDouyinUrl(u)
  return {
    isMedia: isMedia(u),
    site,
    quality: getQuality(u),
    ext,
    mimeHint: mimeHintOf(ext),
    backend,
    kind: isPage ? 'page' : backend === 'direct' ? 'direct' : 'unknown',
    normalizedUrl: normalized !== String(url).trim() ? normalized : undefined,
    hint:
      backend === 'bilibili'
        ? 'B站 视频页面链接：video_resolve 可先看有哪些流，video_download 能直接解析并下载。'
        : backend === 'ytdlp'
          ? site === 'douyin'
            ? '抖音页面：video_download 先用本地浏览器通路取播放源（不吃 Cookie），失败再退回 yt-dlp。'
            : isPlaylistUrl(u)
              ? '播放列表（m3u8/mpd）：交给合并后端抓分片，不要当普通文件存。'
              : '站点页面链接：交给通用后端（本机 yt-dlp）解析与下载，不要求直链。'
          : backend === 'direct'
            ? '看起来是可直接下载的媒体链接。'
            : backend === 'unsupported'
              ? '这是 B站 的非视频页面（专栏/直播/空间），插件不支持。'
              : '既不是媒体直链，也不是可识别的站点页面链接。',
  }
}

// ------------------------------------------------- per-site parsers (pure)

/**
 * Bilibili playurl JSON (DASH or durl) -> media URL list. Pure: takes a text
 * payload, returns an array of { url, quality, size, ext, kind }.
 */
export function parseBilibiliJson(text) {
  const found = []
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return found
  }
  if (j?.data?.dash) found.push(...parseBilibiliDash(j.data.dash))
  if (j?.data?.durl) found.push(...parseBilibiliDurl(j.data.durl))
  if (j?.result?.dash) found.push(...parseBilibiliDash(j.result.dash))
  if (j?.result?.durl) found.push(...parseBilibiliDurl(j.result.durl))
  return found
}

export function parseBilibiliDash(dash) {
  const out = []
  if (!dash) return out
  ;(dash.video || []).forEach((v) => {
    const u = v.baseUrl || v.base_url || v.backupUrl?.[0]
    if (u) out.push({ url: u, quality: BILI_QUALITY[v.id] || v.id + 'P', size: 0, ext: u.includes('.m4s') ? 'm4s' : 'mp4', kind: 'video', id: v.id })
  })
  ;(dash.audio || []).forEach((a, i) => {
    const u = a.baseUrl || a.base_url || a.backupUrl?.[0]
    if (u) out.push({ url: u, quality: '音频' + (i + 1), size: 0, ext: u.includes('.m4s') ? 'm4s' : 'mp4', kind: 'audio', id: a.id })
  })
  return out
}

export function parseBilibiliDurl(durl) {
  const out = []
  if (!Array.isArray(durl)) return out
  durl.forEach((d, i) => {
    if (d.url) out.push({ url: d.url, quality: '分段' + (i + 1), size: d.size || 0, ext: 'mp4', kind: 'video', id: 0 })
  })
  return out
}

/** YouTube player response -> media URLs (kept for parity with the extension). */
export function parseYoutubeStreaming(data) {
  const out = []
  const fmts = [...(data?.streamingData?.formats || []), ...(data?.streamingData?.adaptiveFormats || [])]
  fmts.forEach((f) => {
    if (f.url) out.push({ url: f.url, quality: f.qualityLabel || f.quality || '', size: 0, ext: 'mp4', kind: 'video', id: 0 })
  })
  return out
}

/** Bare mp4/m3u8 URLs embedded in page text (douyin / xiaohongshu). */
export function extractMediaUrls(text, pattern = /https?:\/\/[^"'\s]*\.(m3u8|mp4)[^"'\s]*/g) {
  const urls = String(text).match(pattern)
  if (!urls) return []
  return [...new Set(urls.map((u) => u.replace(/\\u002F/g, '/')))]
}

/**
 * Pick the best video track id from a DASH video array.
 * `prefer` accepts 'best' (default), 'worst', or a numeric quality id / label
 * such as '720' / '1080P'; unknown values fall back to 'best'.
 */
export function pickVideoTrack(videos, prefer = 'best') {
  const list = [...(videos || [])]
  if (list.length === 0) return null
  const byId = new Map()
  for (const v of list) {
    const id = v.id
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(v)
  }
  const ids = [...byId.keys()].sort((a, b) => b - a)
  let chosenId = ids[0]
  const p = String(prefer || 'best').toLowerCase()
  if (p === 'worst') chosenId = ids[ids.length - 1]
  else if (/^\d+$/.test(p)) {
    const want = Number(p)
    const match = ids.find((id) => id === want) || ids.find((id) => Math.abs(id - want) <= 8)
    if (match) chosenId = match
  }
  // prefer avc (codecid 7) for ffmpeg friendliness, then hevc, then av1
  const group = byId.get(chosenId) || []
  const rank = (v) => (v.codecid === 7 ? 0 : v.codecid === 12 ? 1 : v.codecid === 13 ? 2 : 3)
  return [...group].sort((a, b) => rank(a) - rank(b))[0] || null
}

/** Highest-bandwidth audio track. */
export function pickAudioTrack(audios) {
  const list = [...(audios || [])]
  if (list.length === 0) return null
  const rank = (a) => a.bandwidth || 0
  return [...list].sort((a, b) => rank(b) - rank(a))[0]
}

// ---------------------------------------------------------------- download

export function sanitizeName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'media'
}

export function defaultFileName(url, ext) {
  let base = ''
  try {
    const last = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean).pop() || ''
    base = sanitizeName(last.replace(/\.[a-z0-9]+$/i, ''))
  } catch {
    // malformed URL — fall through to the timestamped name
  }
  return `${base || 'media'}.${ext || 'mp4'}`
}

/** Default download directory: explicit env override, then the user's Downloads folder. */
export function defaultDownloadDir() {
  const env = process.env.DSH_VIDEO_DOWNLOAD_DIR
  if (env && env.trim()) return resolve(env.trim())
  return join(homedir(), 'Downloads', 'dsh-video-downloader')
}

/**
 * outPath 指的是「一个目录」而不是文件名时返回该目录，否则返回 null。
 * 判定：末尾带路径分隔符，或者本来就是一个存在的目录。这样传目录就能让插件自己用标题命名。
 */
export function outDirOf(outPath) {
  if (!outPath) return null
  const raw = String(outPath).trim()
  if (!raw) return null
  const looksLikeDir = /[\\/]$/.test(raw) || (existsSync(raw) && statSync(raw).isDirectory())
  if (!looksLikeDir) return null
  return isAbsolute(raw) ? resolve(raw) : resolve(defaultDownloadDir(), raw)
}

function resolveOutPath(url, ext, outPath) {
  const outDir = outDirOf(outPath)
  if (outDir) return join(outDir, defaultFileName(url, ext))
  if (outPath && isAbsolute(outPath)) return outPath
  if (outPath) return resolve(defaultDownloadDir(), outPath)
  return join(defaultDownloadDir(), defaultFileName(url, ext))
}

function refererHeader(url) {
  try {
    const u = new URL(url)
    return { Referer: u.hostname.includes('bilibili.com') ? BILI_REFERER : u.origin + '/' }
  } catch {
    return {}
  }
}

/** Pipe a stream to a file with an inactivity timeout, resolving with the byte count. */
function streamToFile(stream, filePath, { signal, idleMs = IDLE_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = createWriteStream(filePath)
    let bytes = 0
    let settled = false
    let timer = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = null
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const fail = (err) => {
      if (settled) return
      settled = true
      cleanup()
      ws.destroy()
      rejectPromise(err)
    }
    const onAbort = () => fail(new Error('下载已取消'))
    if (signal) {
      if (signal.aborted) return fail(new Error('下载已取消'))
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => fail(new Error(`下载空闲超时（${Math.round(idleMs / 1000)}s 没有收到数据）`)), idleMs)
    }
    arm()
    ws.on('error', fail)
    stream.on('data', (c) => {
      bytes += c.length
      arm()
    })
    stream.on('error', fail)
    stream.pipe(ws)
    ws.on('finish', () => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(bytes)
    })
  })
}

/** Manual redirect loop (<= MAX_REDIRECTS) then stream the body to `filePath`. */
async function fetchStreamToFile(url, filePath, headers, signal, idleMs) {
  let current = url
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetch(current, { headers, signal, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (loc) {
        current = new URL(loc, current).toString()
        continue
      }
      throw new Error(`HTTP ${res.status} 重定向缺少 Location：${current}`)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}：${current}`)
    if (!res.body) throw new Error(`响应体为空：${current}`)
    return streamToFile(Readable.fromWeb(res.body), filePath, { signal, idleMs })
  }
  throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次`)
}

/**
 * Download a direct media URL to disk.
 *
 * @param {string} url direct media URL (mp4/m3u8/mpd/...).
 * @param {object} [options] outPath / headers / signal / idleMs
 * @returns {Promise<{ filePath: string, bytes: number, ext: string }>}
 */
export async function downloadMedia(url, { outPath, headers = {}, signal, idleMs } = {}) {
  const ext = getExt(url)
  const filePath = resolveOutPath(url, ext, outPath)
  mkdirSync(dirname(filePath), { recursive: true })

  const requestHeaders = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...refererHeader(url),
    ...headers,
  }

  const bytes = await fetchStreamToFile(url, filePath, requestHeaders, signal, idleMs)
  return { filePath, bytes, ext }
}

// ------------------------------------------------------------ bilibili I/O

let cookieJar = ''

/** One-off cookie bootstrap: B站 接口对没有 buvid3 的请求直接 412。 */
async function bilibiliCookie(signal) {
  if (cookieJar) return cookieJar
  const res = await fetch('https://www.bilibili.com/', {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal,
  })
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  cookieJar = raw.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ')
  try {
    await res.arrayBuffer()
  } catch {
    // body irrelevant
  }
  return cookieJar
}

async function bilibiliJson(url, signal) {
  const cookie = await bilibiliCookie(signal)
  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Referer: BILI_REFERER,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal,
  })
  const text = await res.text()
  let j
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(`B站接口返回了非 JSON（HTTP ${res.status}），多半是风控拦截（412）`)
  }
  if (j.code !== 0) throw new Error(`B站接口错误 ${j.code}：${j.message || '未知错误'}`)
  return j.data
}

/** b23.tv / bilibili.com/s/xxx 短链 -> 真实地址。 */
async function expandShortLink(input, signal) {
  const s = String(input).trim()
  if (!/^https?:\/\//i.test(s)) return s
  let host = ''
  try {
    host = new URL(s).hostname
  } catch {
    return s
  }
  if (host !== 'b23.tv' && !/\/s\//.test(s)) return s
  const res = await fetch(s, { headers: { 'User-Agent': BROWSER_UA }, redirect: 'follow', signal })
  try {
    await res.arrayBuffer()
  } catch {
    // ignore
  }
  return res.url || s
}

/**
 * Resolve a Bilibili video (BV id / page URL / short link) into concrete
 * DASH streams. Anonymous only: what the site grants without login (usually
 * up to 480P), never touches cookies of a logged-in account.
 */
export async function resolveBilibili(input, { signal, quality = 'best' } = {}) {
  const expanded = await expandShortLink(input, signal)
  const bvid = extractBvid(expanded)
  if (!bvid) throw new Error(`不是可识别的 B 站视频地址：${input}`)
  const page = extractPage(expanded)

  const view = await bilibiliJson(`https://api.bilibili.com/x/web-interface/wbi/view?bvid=${bvid}`, signal)
  const pages = Array.isArray(view.pages) ? view.pages : []
  const pageInfo = pages[page - 1] || pages[0] || { cid: view.cid, page: 1, part: '' }
  const cid = pageInfo.cid || view.cid
  if (!cid) throw new Error('B站接口没有返回 cid')

  const play = await bilibiliJson(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=127&fnval=4048&fourk=1`,
    signal,
  )

  const dash = play.dash
  if (!dash || !Array.isArray(dash.video) || dash.video.length === 0) {
    throw new Error('B站没有返回 DASH 流（可能是番剧/付费内容或地区限制）')
  }

  const video = pickVideoTrack(dash.video, quality)
  const audio = pickAudioTrack(dash.audio)
  if (!video) throw new Error('没有可用的视频轨')

  const deadline = Number(new URL(video.baseUrl || video.base_url).searchParams.get('deadline') || 0)
  const qualities = [...new Set(dash.video.map((v) => v.id))]
    .sort((a, b) => b - a)
    .map((id) => {
      const one = dash.video.find((v) => v.id === id) || {}
      return {
        id,
        label: BILI_QUALITY[id] || `${id}P`,
        height: one.height || 0,
        codec: one.codecs || '',
      }
    })

  return {
    site: 'bilibili',
    bvid,
    cid,
    page,
    pageTitle: pageInfo.part || '',
    title: view.title || '',
    durationSec: view.duration || 0,
    qualities,
    video: {
      qualityId: video.id,
      qualityLabel: BILI_QUALITY[video.id] || `${video.id}P`,
      width: video.width || 0,
      height: video.height || 0,
      codec: video.codecs || '',
      url: video.baseUrl || video.base_url,
      backupUrls: video.backupUrl || video.backup_url || [],
    },
    audio: audio
      ? {
          id: audio.id,
          bandwidth: audio.bandwidth || 0,
          codec: audio.codecs || '',
          url: audio.baseUrl || audio.base_url,
          backupUrls: audio.backupUrl || audio.backup_url || [],
        }
      : null,
    requiresMux: Boolean(audio),
    expiresAt: deadline ? deadline * 1000 : 0,
    note: 'URL 有时效（约 2 小时），过期重新解析即可；匿名最高清晰度受站点限制。',
  }
}

// ------------------------------------------------------------------ ffmpeg

let ffmpegProbe = null

/** Locate ffmpeg once; returns the command or '' when unavailable. */
export function findFfmpeg() {
  if (ffmpegProbe !== null) return ffmpegProbe
  const envPath = process.env.DSH_FFMPEG_PATH
  if (envPath) {
    ffmpegProbe = envPath
    return ffmpegProbe
  }
  ffmpegProbe = ''
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 })
    ffmpegProbe = 'ffmpeg'
  } catch {
    ffmpegProbe = ''
  }
  return ffmpegProbe
}

function muxTracks(ffmpeg, videoPath, audioPath, outPath, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', '-movflags', '+faststart', outPath]
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], signal })
    let stderr = ''
    child.stderr.on('data', (c) => {
      stderr += c.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })
    child.on('error', (err) => rejectPromise(new Error(`ffmpeg 启动失败：${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`ffmpeg 合并失败（exit ${code}）：${stderr.trim().split('\n').slice(-3).join(' ')}`))
    })
  })
}

/**
 * Download a Bilibili video: resolve -> fetch video/audio -> mux with ffmpeg.
 * Falls back to two separate files when ffmpeg is unavailable.
 */
export async function downloadBilibili(input, { outPath, signal, quality = 'best', idleMs } = {}) {
  const info = await resolveBilibili(input, { signal, quality })
  const outDir = outDirOf(outPath)
  const dir = outDir || (outPath && isAbsolute(outPath) ? dirname(outPath) : defaultDownloadDir())
  mkdirSync(dir, { recursive: true })

  const base = outDir
    ? join(outDir, `${sanitizeName(info.title || info.bvid)}_${info.bvid}${info.page > 1 ? `_p${info.page}` : ''}`)
    : outPath && isAbsolute(outPath)
      ? outPath.replace(/\.[a-z0-9]+$/i, '')
      : join(dir, `${sanitizeName(info.title || info.bvid)}_${info.bvid}${info.page > 1 ? `_p${info.page}` : ''}`)

  const headers = { 'User-Agent': BROWSER_UA, Referer: `https://www.bilibili.com/video/${info.bvid}` }
  const videoTmp = `${base}.video.m4s`
  const audioTmp = `${base}.audio.m4s`

  const videoBytes = await fetchStreamToFile(info.video.url, videoTmp, headers, signal, idleMs)
  let audioBytes = 0
  if (info.audio) audioBytes = await fetchStreamToFile(info.audio.url, audioTmp, headers, signal, idleMs)

  const ffmpeg = findFfmpeg()
  if (info.audio && ffmpeg) {
    const finalPath = `${base}.mp4`
    await muxTracks(ffmpeg, videoTmp, audioTmp, finalPath, signal)
    try {
      unlinkSync(videoTmp)
      unlinkSync(audioTmp)
    } catch {
      // leftovers are harmless
    }
    return {
      savedTo: finalPath,
      bytes: videoBytes + audioBytes,
      videoBytes,
      audioBytes,
      muxed: true,
      quality: info.video.qualityLabel,
      title: info.title,
      bvid: info.bvid,
      page: info.page,
      durationSec: info.durationSec,
    }
  }

  // No ffmpeg (or no audio track): keep the video track as-is and report the audio side file.
  const videoPath = `${base}.${info.video.qualityLabel}.m4s`
  renameSync(videoTmp, videoPath)
  if (info.audio) {
    const audioPath = `${base}.audio.m4s`
    renameSync(audioTmp, audioPath)
    return {
      savedTo: videoPath,
      audioFile: audioPath,
      bytes: videoBytes + audioBytes,
      videoBytes,
      audioBytes,
      muxed: false,
      needsMux: true,
      quality: info.video.qualityLabel,
      title: info.title,
      bvid: info.bvid,
      page: info.page,
      durationSec: info.durationSec,
      note: '本机没有可用的 ffmpeg：音视频已分别落盘，合并播放需自行用 ffmpeg -i video -i audio -c copy out.mp4，或把 DSH_FFMPEG_PATH 指向 ffmpeg.exe。',
    }
  }
  return {
    savedTo: videoPath,
    bytes: videoBytes,
    muxed: true,
    quality: info.video.qualityLabel,
    title: info.title,
    bvid: info.bvid,
    page: info.page,
    durationSec: info.durationSec,
  }
}

// ------------------------------------------------------------- yt-dlp backend
// Everything that is not Bilibili and not a direct media URL goes through the
// local yt-dlp binary: it owns per-site extraction, signature logic and login
// state, so this plugin does not have to chase site changes.

let ytdlpProbe = null

/** Locate yt-dlp once; returns the command or '' when unavailable. */
export function findYtDlp() {
  if (ytdlpProbe !== null) return ytdlpProbe
  const envPath = process.env.DSH_YTDLP_PATH
  if (envPath) {
    ytdlpProbe = envPath
    return ytdlpProbe
  }
  ytdlpProbe = ''
  for (const cmd of ['yt-dlp', 'yt-dlp.exe']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 8000 })
      ytdlpProbe = cmd
      break
    } catch {
      // try the next candidate
    }
  }
  return ytdlpProbe
}

/** Map yt-dlp stderr onto a small, agent-readable error code. */
export function classifyYtDlpError(text) {
  const s = String(text || '')
  if (/Unsupported URL|is not a valid URL|no suitable InfoExtractor/i.test(s)) return 'unsupported'
  if (/Blocked by ArgusSecurityPlugin|Uifid Not Found|verify the signature|invalid signature/i.test(s)) return 'blocked'
  if (/This video is unavailable|Video unavailable|has been removed|This video is private|not available in your country/i.test(s)) return 'unavailable'
  if (/Sign in to confirm|Please sign in|log ?in|Login required|members-only|This video is only available|confirm your age|cookies/i.test(s)) return 'need_login'
  if (/HTTP Error 404|404: Not Found/i.test(s)) return 'not_found'
  if (/HTTP Error 40[13]|HTTP Error 429|Too Many Requests|Forbidden/i.test(s)) return 'blocked'
  if (/ffmpeg (?:not found|is not installed)|ffprobe/i.test(s)) return 'missing_ffmpeg'
  if (/Unable to download|timed out|Connection|getaddrinfo|Temporary failure|network/i.test(s)) return 'network'
  return 'download_failed'
}

/** Keep only the meaningful tail of yt-dlp stderr (drops Python deprecation noise). */
function ytdlpMessage(stderr, code) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Deprecated Feature/i.test(l) && !/^WARNING:/i.test(l))
  return lines.slice(-3).join(' ') || `yt-dlp 退出码 ${code}`
}

function ytdlpArgs(url, { cookies } = {}) {
  const args = ['--no-playlist', '--no-warnings', '--no-mtime', '--newline']
  const explicit = (process.env.DSH_YTDLP_PROXY || '').trim()
  if (explicit) args.push('--proxy', explicit)
  // Douyin rejects requests that arrive through a desktop system proxy with
  // `Blocked by ArgusSecurityPlugin`; ask for a direct connection there unless
  // the caller pinned a proxy explicitly.
  else if (detectSite(url) === 'douyin') args.push('--proxy', '')
  if (cookies) args.push('--cookies', cookies)
  args.push(url)
  return args
}

function runYtDlp(bin, args, { signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    // yt-dlp is a Python program: without these it writes console output in the
    // Windows ANSI code page and any CJK title comes back as mojibake.
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => {
      stdout += c.toString()
      if (stdout.length > 400_000) stdout = stdout.slice(-400_000)
    })
    child.stderr.on('data', (c) => {
      stderr += c.toString()
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000)
    })
    child.on('error', (err) => rejectPromise(new Error(`无法启动 yt-dlp：${err.message}`)))
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

const YTDLP_FORMATS = {
  best: 'bv*+ba/b',
  worst: 'wv*+wa/w',
}

function formatSelector(quality) {
  const q = String(quality || 'best').trim()
  if (YTDLP_FORMATS[q]) return YTDLP_FORMATS[q]
  if (/^\d+$/.test(q)) return `${q}+ba/${q}`
  return YTDLP_FORMATS.best
}

/** Ask yt-dlp for metadata only (`-J`), without downloading. */
export async function resolveWithYtDlp(input, { cookies, signal } = {}) {
  const bin = findYtDlp()
  if (!bin) throw new Error('本机没有找到 yt-dlp，无法解析这个站点。安装后重试，或用 DSH_YTDLP_PATH 指向 yt-dlp.exe。')
  const { code, stdout, stderr } = await runYtDlp(bin, [...ytdlpArgs(input, { cookies }), '-J', '--skip-download'], { signal })
  if (code !== 0) {
    const err = new Error(ytdlpMessage(stderr, code))
    err.code = classifyYtDlpError(stderr)
    throw err
  }
  const info = JSON.parse(stdout)
  const formats = Array.isArray(info.formats) ? info.formats : []
  return {
    backend: 'ytdlp',
    site: info.extractor_key || info.extractor || 'unknown',
    title: info.title,
    uploader: info.uploader || info.channel || '',
    durationSec: info.duration ?? 0,
    webpageUrl: info.webpage_url || input,
    thumbnail: info.thumbnail || '',
    qualities: formats
      .filter((f) => f.vcodec && f.vcodec !== 'none')
      .map((f) => ({
        formatId: f.format_id,
        ext: f.ext,
        height: f.height ?? null,
        fps: f.fps ?? null,
        codec: f.vcodec,
        filesize: f.filesize ?? f.filesize_approx ?? null,
      }))
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
      .slice(0, 20),
    audioOnly: formats.some((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')),
    note: '这是通用后端的解析结果；下载请用 video_download 给同一个链接。',
  }
}

/** Download any yt-dlp-supported page into the standard download directory. */
export async function downloadWithYtDlp(input, { outPath, cookies, signal, quality = 'best' } = {}) {
  const bin = findYtDlp()
  if (!bin) {
    const err = new Error('本机没有找到 yt-dlp，无法下载这个站点。安装后重试，或用 DSH_YTDLP_PATH 指向 yt-dlp.exe。')
    err.code = 'backend_missing'
    throw err
  }
  const outDir = outDirOf(outPath)
  const dir = outDir || (outPath && isAbsolute(outPath) ? dirname(outPath) : defaultDownloadDir())
  mkdirSync(dir, { recursive: true })
  const template = outDir
    ? join(outDir, '%(title).80s [%(id)s].%(ext)s')
    : outPath && isAbsolute(outPath)
      ? `${outPath.replace(/\.[a-z0-9]{1,5}$/i, '')}.%(ext)s`
      : join(dir, '%(title).80s [%(id)s].%(ext)s')

  const args = [
    ...ytdlpArgs(input, { cookies }),
    '-o', template,
    '-f', formatSelector(quality),
    '--merge-output-format', 'mp4',
    '--print', 'before_dl:###TITLE###%(title)s',
    '--print', 'after_move:filepath',
  ]
  const { code, stdout, stderr } = await runYtDlp(bin, args, { signal })
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const savedTo = [...lines].reverse().find((l) => isAbsolute(l))
  const titleLine = lines.find((l) => l.startsWith('###TITLE###'))
  if (code !== 0 || !savedTo) {
    const err = new Error(ytdlpMessage(stderr, code))
    err.code = classifyYtDlpError(stderr)
    throw err
  }
  let bytes = 0
  try {
    bytes = statSync(savedTo).size
  } catch {
    // size is informative only
  }
  return {
    backend: 'ytdlp',
    savedTo,
    bytes,
    quality: String(quality || 'best'),
    title: titleLine ? titleLine.slice('###TITLE###'.length) : '',
  }
}

// ------------------------------------------------------- douyin browser backend
// Douyin's detail API answers 403 unless a signed, cookie-bearing request comes
// in, and the video page is a SPA whose HTML ships no media URL at all. The one
// route that works without a login is a real browser: open the page, let its
// player pick a source, then read that source off the <video> element. The URL
// carries a short-lived signature, so it is used for one download and dropped.

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

const DOUYIN_SRC_EXPR = [
  '(() => {',
  "  const v = document.querySelector('video')",
  '  const src = (v && (v.currentSrc || v.src)) || ""',
  '  const width = (v && v.videoWidth) || 0',
  '  const height = (v && v.videoHeight) || 0',
  '  const duration = (v && isFinite(v.duration) && v.duration) || 0',
  '  const title = (document.title || "").replace(/\\s*-\\s*抖音\\s*$/, "").trim()',
  '  const list = []',
  '  if (src) list.push(src)',
  '  performance.getEntriesByType("resource").map((e) => e.name)',
  '    .filter((n) => /douyinvod|\\/video\\/tos\\//.test(n) && /mime_type=video_mp4|\\.mp4/.test(n))',
  '    .forEach((n) => { if (!list.includes(n)) list.push(n) })',
  '  return { src, candidates: list, width, height, duration, title }',
  '})()',
].join('\n')

/** 一次要一个字节，从 Content-Range 里读回总量 —— 用来在候选流里挑最大的那条。 */
async function probeContentSize(url, { signal, timeoutMs = 6000 } = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        Range: 'bytes=0-0',
        Referer: 'https://www.douyin.com/',
        'User-Agent': BROWSER_UA,
      },
      redirect: 'follow',
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
    await res.arrayBuffer().catch(() => {})
    const range = res.headers.get('content-range') || ''
    const m = range.match(/\/(\d+)\s*$/)
    if (m) return parseInt(m[1], 10)
    const len = res.headers.get('content-length')
    return len ? parseInt(len, 10) : 0
  } catch {
    return 0
  }
}

const DOUYIN_DIM_EXPR = [
  '(() => {',
  "  const v = document.querySelector('video')",
  '  if (!v) return { width: 0, height: 0 }',
  '  return { width: v.videoWidth || 0, height: v.videoHeight || 0 }',
  '})()',
].join('\n')

const DOUYIN_KICK_EXPR = [
  '(() => {',
  "  const v = document.querySelector('video')",
  '  if (!v) return false',
  '  try { v.muted = true; v.play() } catch (e) {}',
  "  return (v.currentSrc || '').slice(0, 16)",
  '})()',
].join('\n')

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

/** 小于这个体积基本是抖音的试看片段，不是完整作品。 */
const PREVIEW_BYTES = 800_000

let browserProbe = null

/** Locate the browser used for the Douyin path; '' when none is installed. */
export function findBrowser() {
  if (browserProbe !== null) return browserProbe
  const envPath = (process.env.DSH_BROWSER_PATH || '').trim()
  if (envPath) {
    browserProbe = envPath
    return browserProbe
  }
  browserProbe = ''
  for (const candidate of EDGE_CANDIDATES) {
    if (existsSync(candidate)) {
      browserProbe = candidate
      break
    }
  }
  return browserProbe
}

/** One free loopback port for the debugging endpoint. */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

async function waitForDevtools(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) {
        const info = await res.json()
        if (info && info.webSocketDebuggerUrl) return info
      }
    } catch {
      // the browser is still starting
    }
    await delay(250)
  }
  throw new Error('浏览器调试端口没有起来')
}

/** Minimal CDP client: request/response over one flat WebSocket. */
function openCdp(wsUrl) {
  return new Promise((done, fail) => {
    let ws
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      fail(err)
      return
    }
    const pending = new Map()
    let seq = 0
    const abortAll = (err) => {
      for (const item of pending.values()) item.reject(err)
      pending.clear()
      fail(err)
    }
    ws.addEventListener('open', () => {
      done({
        send(method, params = {}, sessionId) {
          const id = ++seq
          const payload = { id, method, params }
          if (sessionId) payload.sessionId = sessionId
          return new Promise((res, rej) => {
            pending.set(id, { res, rej })
            ws.send(JSON.stringify(payload))
          })
        },
        close() {
          try {
            ws.close()
          } catch {
            // already gone
          }
        },
      })
    })
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      } catch {
        return
      }
      if (!msg || !msg.id || !pending.has(msg.id)) return
      const item = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) item.reject(new Error(msg.error.message || 'CDP 调用失败'))
      else item.res(msg.result)
    })
    ws.addEventListener('error', () => abortAll(new Error('CDP 连接失败')))
    ws.addEventListener('close', () => abortAll(new Error('CDP 连接已关闭')))
  })
}

async function evalIn(call, expression) {
  try {
    const res = await call('Runtime.evaluate', { expression, returnByValue: true })
    return res?.result?.value
  } catch {
    return ''
  }
}

/**
 * 常驻的无头浏览器：抖音这条路上「起进程 + 冷缓存」占了大头，留着复用能省掉
 * 每次 1 秒上下的启动与重新拉取页面资源。空闲 3 分钟自动退出，profile 留在 tmp 里当缓存。
 */
let warmBrowser = null
const WARM_IDLE_MS = 180_000
let exitHookBound = false

function warmBrowserAlive() {
  return !!(warmBrowser && warmBrowser.child && warmBrowser.child.exitCode === null)
}

function shutdownWarmBrowser() {
  if (!warmBrowser) return
  const current = warmBrowser
  warmBrowser = null
  if (current.idleTimer) clearTimeout(current.idleTimer)
  try {
    current.child.kill()
  } catch {
    // already exited
  }
}

function bindExitHook() {
  if (exitHookBound) return
  exitHookBound = true
  const bye = () => shutdownWarmBrowser()
  process.once('exit', bye)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.once(sig, () => {
        bye()
        process.exit(130)
      })
    } catch {
      // 不支持的信号就跳过
    }
  }
}

function launchBrowser(bin, profileDir) {
  return freePort().then(async (port) => {
    const child = spawn(
      bin,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--mute-audio',
        '--disable-blink-features=AutomationControlled',
        '--autoplay-policy=no-user-gesture-required',
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true },
    )
    const { webSocketDebuggerUrl } = await waitForDevtools(port, Date.now() + 15_000)
    // 常驻进程不能拖住宿主的事件循环，出问题由 exit 钩子负责收尸
    if (typeof child.unref === 'function') child.unref()
    return { child, port, profileDir, wsUrl: webSocketDebuggerUrl, idleTimer: null }
  })
}

async function acquireBrowser(bin) {
  if (warmBrowserAlive()) {
    if (warmBrowser.idleTimer) clearTimeout(warmBrowser.idleTimer)
    warmBrowser.idleTimer = null
    return warmBrowser
  }
  shutdownWarmBrowser()
  bindExitHook()
  const shared = join(tmpdir(), 'dsh-douyin-profile')
  mkdirSync(shared, { recursive: true })
  try {
    warmBrowser = await launchBrowser(bin, shared)
  } catch {
    // 共享 profile 可能被上次异常退出的实例占着，退回一次性 profile
    shutdownWarmBrowser()
    warmBrowser = await launchBrowser(bin, mkdtempSync(join(tmpdir(), 'dsh-douyin-')))
  }
  const session = warmBrowser
  session.child.once('exit', () => {
    if (warmBrowser === session) warmBrowser = null
  })
  return warmBrowser
}

function releaseBrowser(idleMs = WARM_IDLE_MS) {
  if (!warmBrowserAlive()) {
    shutdownWarmBrowser()
    return
  }
  if (warmBrowser.idleTimer) clearTimeout(warmBrowser.idleTimer)
  const timer = setTimeout(() => shutdownWarmBrowser(), idleMs)
  if (typeof timer.unref === 'function') timer.unref()
  warmBrowser.idleTimer = timer
}

/**
 * Open a Douyin video page in the warm headless browser and read the playing
 * source off the player. Returns the signed media URL; nothing is written to the
 * plugin's own storage.
 */
export async function resolveDouyinWithBrowser(input, { signal, timeoutMs = 30_000 } = {}) {
  const pageUrl = normalizeDouyinUrl(input)
  const bin = findBrowser()
  if (!bin) {
    const err = new Error('本机没有找到 Edge/Chrome，抖音这条通路需要浏览器；可用 DSH_BROWSER_PATH 指定路径。')
    err.code = 'backend_missing'
    throw err
  }
  if (signal?.aborted) throw new Error('执行已取消')

  const session = await acquireBrowser(bin)
  const cdp = await openCdp(session.wsUrl)
  let targetId = ''
  try {
    {
      const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
      targetId = created.targetId
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
      const call = (method, params) => cdp.send(method, params, sessionId)
      await call('Page.enable', {})
      await call('Runtime.enable', {})
      // 图片和字体对取流没用，挡掉能让页面早几百毫秒出播放器
      try {
        await call('Network.enable', {})
        await call('Network.setBlockedURLs', {
          urls: ['*.png', '*.jpg', '*.jpeg', '*.webp', '*.gif', '*.svg', '*.ico', '*.woff', '*.woff2', '*.ttf'],
        })
      } catch {
        // 老版本内核不支持就算了
      }
      await call('Page.navigate', { url: pageUrl })

      let mediaUrl = ''
      let title = ''
      let width = 0
      let height = 0
      let duration = 0
      let contentBytes = 0
      let candidates = []
      const sizes = new Map()
      const startedAt = Date.now()
      const deadline = startedAt + timeoutMs
      const kickAt = startedAt + 1200
      let kicked = false
      let kickedForPreview = false
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('执行已取消')
        // 有些页面不主动起播就不去取真实码流（只挂着一份 2.6 秒的试看片），敲一下 play()
        if (!kicked && Date.now() >= kickAt) {
          kicked = true
          const cur = await evalIn(call, DOUYIN_KICK_EXPR)
          if (typeof cur === 'string' && cur) kickedForPreview = true
        }
        const probe = await evalIn(call, DOUYIN_SRC_EXPR)
        if (probe && typeof probe === 'object') {
          title = String(probe.title || '') || title
          // 播放器会先给一个较小的占位尺寸再换到真实码流，取整段轮询里的最大值
          if (Number(probe.width) > width) width = Number(probe.width)
          if (Number(probe.height) > height) height = Number(probe.height)
          duration = Number(probe.duration) || duration
          candidates = Array.isArray(probe.candidates)
            ? probe.candidates.filter((u) => /^https?:\/\//i.test(u))
            : []
        } else if (typeof probe === 'string' && /^https?:\/\//i.test(probe)) {
          candidates = [probe]
        }
        if (candidates.length) {
          const shortlist = candidates.slice(0, 4)
          await Promise.all(
            shortlist.map(async (u) => {
              if (!sizes.has(u)) sizes.set(u, await probeContentSize(u, { signal }))
            }),
          )
          for (const u of shortlist) {
            const size = sizes.get(u) || 0
            if (!mediaUrl || size > contentBytes) {
              mediaUrl = u
              contentBytes = size
            }
          }
          // 页面偶尔先给一条几秒钟的试看流：再敲一次 play() 逼它换到完整码流
          if (!kickedForPreview && contentBytes && contentBytes < PREVIEW_BYTES) {
            kickedForPreview = true
            await evalIn(call, DOUYIN_KICK_EXPR)
          }
          const settled = (title && (!contentBytes || contentBytes >= PREVIEW_BYTES)) || candidates.length > 1
          if (settled) break
          if (Date.now() - startedAt > 15_000) break
        }
        await delay(150)
      }
      if (!mediaUrl) {
        const err = new Error('播放页在时限内没有给出可下载地址（可能需要登录，或这个作品已失效）')
        err.code = 'no_stream'
        throw err
      }
      // 分辨率只用来打 quality 标签，不再为它多等：读到就写，读不到就按 URL 推
      if (!height) {
        const dim = await evalIn(call, DOUYIN_DIM_EXPR)
        height = Number(dim?.height) || 0
        width = Number(dim?.width) || width
      }
      return {
        backend: 'douyin-browser',
        pageUrl,
        mediaUrl,
        title,
        width,
        height,
        duration,
        bytes: contentBytes,
        candidates: candidates.length,
        quality: width && height ? `${Math.min(width, height)}P` : getQuality(mediaUrl),
      }
    }
  } finally {
    if (targetId) {
      try {
        await Promise.race([
          cdp.send('Target.closeTarget', { targetId }),
          delay(1500).then(() => {
            throw new Error('closeTarget timeout')
          }),
        ])
      } catch {
        // 关不掉不影响结果，下次复用新的 target
      }
    }
    cdp.close()
    releaseBrowser()
  }
}

/** Resolve a Douyin page through the browser and save the file it points at. */
/** 用本机 ffmpeg 读落盘文件的真实宽高；拿不到就返回 null。 */
function probeVideoDims(filePath) {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) return null
  let text = ''
  try {
    text = String(execFileSync(ffmpeg, ['-hide_banner', '-i', filePath], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 8000 }))
  } catch (err) {
    text = String(err?.stderr || '')
  }
  const hit = text.match(/(\d{2,5})x(\d{2,5})/)
  if (!hit) return null
  const width = Number(hit[1])
  const height = Number(hit[2])
  return width && height ? { width, height } : null
}

export async function downloadDouyin(input, { outPath, signal, idleMs } = {}) {
  const resolved = await resolveDouyinWithBrowser(input, { signal })
  const id = douyinVideoId(input)
  const stem = sanitizeName(resolved.title || id || 'douyin')
  const outDir = outDirOf(outPath)
  const target = outDir
    ? join(outDir, `${stem}${id ? `_${id}` : ''}.mp4`)
    : outPath && isAbsolute(outPath)
      ? `${outPath.replace(/\.[a-z0-9]{1,5}$/i, '')}.mp4`
      : join(defaultDownloadDir(), `${stem}${id ? `_${id}` : ''}.mp4`)
  const { filePath, bytes } = await downloadMedia(resolved.mediaUrl, {
    outPath: target,
    headers: { Referer: 'https://www.douyin.com/' },
    signal,
    idleMs,
  })
  const dims = probeVideoDims(filePath)
  return {
    backend: 'douyin-browser',
    savedTo: filePath,
    bytes,
    quality: dims ? `${Math.min(dims.width, dims.height)}P` : resolved.quality,
    title: resolved.title,
    sourceUrl: resolved.pageUrl,
  }
}

// -------------------------------------------------------------------- tools

const renderText = (_args, value) => [{ type: 'text', text: value }]

const OUTPUT = { schema: { type: 'string' }, render: renderText }

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'video_analyze',
    description:
      '快速判断一个链接：是不是媒体、属于哪个站点（bilibili/youtube/douyin/xiaohongshu/other）、' +
      '会由哪个后端处理、可能清晰度、容器扩展名与 mime 提示。纯分析，不联网。返回 JSON ' +
      '{ isMedia, site, quality, ext, mimeHint, backend, kind, hint }；backend=bilibili 走内置解析，' +
      'backend=ytdlp 表示这是其他站点页面链接、交给本机通用后端，backend=direct 是媒体直链，' +
      'backend=unsupported 是本插件不处理的情况。kind=page 的链接可以直接交给 video_download。',
    parameters: {
      url: { type: 'string', required: true, description: '要分析的链接（页面链接或媒体直链）。' },
    },
    output: OUTPUT,
    async execute(args) {
      return JSON.stringify(analyze(args.url))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_resolve',
    description:
      '把视频页面链接解析成真实媒体流，不下载。B站 视频页/BV 号/b23.tv 短链走内置解析；' +
      '抖音页面（含个人页 ?modal_id=、短链、分享文本）先用本地浏览器通路取播放源，再退回 yt-dlp；' +
      '其他站点（小红书、YouTube、快手等）交给本机通用后端 yt-dlp 解析。' +
      'B站 返回 { site, bvid, cid, page, title, durationSec, qualities[], video{...}, audio{...}, requiresMux, expiresAt }；' +
      '抖音返回 { backend:"douyin-browser", pageUrl, title, qualities[] }；' +
      '通用后端返回 { backend:"ytdlp", site, title, uploader, durationSec, qualities[], audioOnly }。' +
      '成功返回解析结果；失败返回 { error, message }，error 取值 unsupported / need_login / blocked / network / backend_missing / no_stream。',
    parameters: {
      url: { type: 'string', required: true, description: '视频页面链接、BV 号或 b23.tv 短链。' },
      quality: { type: 'string', description: '清晰度偏好：best（默认）/ worst / 数字质量 id（如 64）。' },
      cookies: { type: 'string', description: '可选：cookies.txt 的绝对路径，用于需要登录态的内容（B站 以外站点）。' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const url = String(args.url).trim()
      try {
        if (isResolvablePage(url)) {
          const info = await resolveBilibili(url, { signal: exec?.signal, quality: args.quality || 'best' })
          return JSON.stringify(info, null, 2)
        }
        if (routeFor(url) === 'ytdlp') {
          if (detectSite(url) === 'douyin') {
            try {
              const page = await resolveDouyinWithBrowser(url, { signal: exec?.signal })
              return JSON.stringify(
                {
                  backend: 'douyin-browser',
                  site: 'douyin',
                  pageUrl: page.pageUrl,
                  title: page.title,
                  durationSec: 0,
                  qualities: [{ formatId: 'browser', ext: 'mp4', quality: page.quality }],
                  audioOnly: false,
                  note: '这是浏览器通路取到的播放源（带时效签名，不落盘）；下载请用 video_download 给同一个页面链接。',
                },
                null,
                2,
              )
            } catch {
              // Douyin also has a yt-dlp extractor; try it before giving up.
            }
          }
          const info = await resolveWithYtDlp(url, { cookies: args.cookies, signal: exec?.signal })
          return JSON.stringify(info, null, 2)
        }
        return JSON.stringify({ error: 'unsupported', message: analyze(url).hint })
      } catch (err) {
        return JSON.stringify({ error: err?.code || 'resolve_failed', message: err?.message || String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_download',
    description:
      '把视频下载到本机，接受三类输入：①媒体直链（mp4/m3u8/mpd/flv/m4s/音频）直接下；' +
      '②B站 视频页面链接 / BV 号 / b23.tv 短链，内置解析 + ffmpeg 合并；' +
      '③其他站点页面链接（抖音、小红书、YouTube、快手等），交给本机通用后端 yt-dlp 下载。' +
      '抖音（含个人页 ?modal_id=、短链、分享文本）先用无头浏览器取播放源、不吃 Cookie；' +
      'm3u8/mpd 播放列表交给合并后端抓分片，不会把播放列表文本当成视频存下来。' +
      '返回 JSON { savedTo, bytes, quality, backend, title?, elapsedMs }；savedTo 是真实绝对路径。' +
      '失败返回 { error, message }，error 取值 unsupported / need_login / blocked / network / missing_ffmpeg / backend_missing / no_stream / download_failed。' +
      '默认目录：$DSH_VIDEO_DOWNLOAD_DIR，未设置时为用户 Downloads/dsh-video-downloader。',
    parameters: {
      url: { type: 'string', required: true, description: '媒体直链、B站 视频页链接，或其他站点的视频页面链接。' },
      outPath: { type: 'string', description: '可选保存路径；传目录（已存在的目录，或以 / \\ 结尾）时按视频标题自动命名并放进该目录，传文件名则按该名保存；相对路径相对默认下载目录。' },
      quality: { type: 'string', description: '清晰度偏好：best（默认）/ worst / 数字质量 id。' },
      cookies: { type: 'string', description: '可选：cookies.txt 的绝对路径，用于需要登录态的内容（B站 以外站点）。' },
      headers: { type: 'object', additionalProperties: true, description: '可选额外请求头，仅对直链下载生效。' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const started = Date.now()
      const url = String(args.url).trim()
      const controller = new AbortController()
      const onOuterAbort = () => controller.abort(new Error('执行已取消'))
      if (exec?.signal) {
        if (exec.signal.aborted) controller.abort(new Error('执行已取消'))
        else exec.signal.addEventListener('abort', onOuterAbort, { once: true })
      }
      try {
        const route = routeFor(url)
        if (route === 'bilibili') {
          const info = await downloadBilibili(url, {
            outPath: args.outPath,
            quality: args.quality || 'best',
            signal: controller.signal,
          })
          return JSON.stringify({ backend: 'bilibili', ...info, elapsedMs: Date.now() - started })
        }
        if (route === 'unsupported') {
          return JSON.stringify({ error: 'unsupported', message: analyze(url).hint })
        }
        if (route === 'ytdlp') {
          if (detectSite(url) === 'douyin') {
            try {
              const info = await downloadDouyin(url, { outPath: args.outPath, signal: controller.signal })
              return JSON.stringify({ ...info, elapsedMs: Date.now() - started })
            } catch (err) {
              // 抖音走 yt-dlp 基本必 403 且会卡上分钟，只有「没浏览器」才值得回退
              if (err?.code !== 'backend_missing') {
                return JSON.stringify({
                  error: err?.code || 'download_failed',
                  message: err?.message || String(err),
                  elapsedMs: Date.now() - started,
                })
              }
            }
          }
          const info = await downloadWithYtDlp(url, {
            outPath: args.outPath,
            cookies: args.cookies,
            quality: args.quality || 'best',
            signal: controller.signal,
          })
          return JSON.stringify({ ...info, elapsedMs: Date.now() - started })
        }
        if (route === 'none') {
          return JSON.stringify({ error: 'unsupported', message: analyze(url).hint })
        }
        const { filePath, bytes, ext } = await downloadMedia(url, {
          outPath: args.outPath,
          headers: args.headers,
          signal: controller.signal,
        })
        return JSON.stringify({
          backend: 'direct',
          savedTo: filePath,
          bytes,
          quality: getQuality(url),
          ext,
          elapsedMs: Date.now() - started,
        })
      } catch (err) {
        return JSON.stringify({
          error: err?.code || 'download_failed',
          message: err?.message || String(err),
          elapsedMs: Date.now() - started,
        })
      } finally {
        if (exec?.signal) exec.signal.removeEventListener('abort', onOuterAbort)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_quality_parse',
    description:
      '纯正则解析链接里的清晰度与扩展名，不联网。返回 JSON { quality, ext }。' +
      '清晰度按 尺寸/height 参数/码率阈值/关键词/容器 逐级猜测。',
    parameters: {
      url: { type: 'string', required: true, description: '要分析的媒体链接。' },
    },
    output: OUTPUT,
    async execute(args) {
      const url = String(args.url)
      return JSON.stringify({ quality: getQuality(url), ext: getExt(url) })
    },
  }))
}
