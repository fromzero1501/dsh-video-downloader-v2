/**
 * 关键词批量爬取（P0：快手）。纯 node 内建模块，不依赖宿主包。
 *
 * 目录口径： <根>\<平台中文名>\<用户原始关键词>\<标题 [视频id].mp4
 * 索引：     $DSH_HOME/video-downloader/index.jsonl（一行一条，去重键 平台:id）
 * 任务态：   $DSH_HOME/video-downloader/crawl/<jobId>.json
 *
 * 行为约定（与用户确认过）：
 *   - 抓多少条由调用方给，没给就 10 条。
 *   - 先同词翻页到底；不够条数再用同义词逐个搜（同义词由 agent 生成后传进来）。
 *   - 遇限流退避重试；遇验证码/风控立刻暂停并留证据，等人工处理后 resume。
 *   - 已在索引里且文件还在盘的条目跳过（可重复跑，增量）。
 *
 * 性能取舍（2026-11-25 实测，见 README「耗时与并发」）：
 *   - 搜索和下载走两条不同通道（API vs CDN），**并行跑**：搜到前几条就让下载协程开工，
 *     总时长从「搜索 + 下载」变成「max(搜索, 下载)」。
 *   - 下载并发默认 6：实测聚合吞吐 2→6.2MB/s、4→19.8、6→36.7、8→30.7，拐点在 6。
 *   - 不做 Range 分段：同一批文件分段实测总时长反而比单流长 69%（小文件分段更差），
 *     长尾改用「单条超时重连」，理由与数据都在 README。
 */

import {
  appendFileSync, closeSync, createWriteStream, existsSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { kuaishouFeeds, kuaishouFileName, kuaishouVerdict, openKuaishouSession } from './kuaishou.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const PLATFORM_LABELS = {
  kuaishou: '快手',
  bilibili: 'B站',
  youtube: 'YouTube',
  douyin: '抖音',
  xiaohongshu: '小红书',
  other: '其他',
}

/** 平台标识 → 落盘用的中文目录名。 */
export function platformLabel(platform) {
  const key = String(platform || '').trim().toLowerCase()
  return PLATFORM_LABELS[key] || key || '其他'
}

/** 目录名清洗：保留中文与空格，去掉 Windows 非法字符与首尾点。 */
export function safeDirName(name) {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60)
  return s || '未命名'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一次爬取的默认值：用户没说条数就 10 条。 */
export const CRAWL_DEFAULT_LIMIT = 10
export const CRAWL_DEFAULT_MAX_PAGES = 10

export function crawlDirName(stateDir) {
  return join(stateDir, 'crawl')
}

export function crawlIndexPath(stateDir) {
  return join(stateDir, 'index.jsonl')
}

/** 读索引成 Map：key = `平台:id` → { file, bytes, at }。坏行跳过。 */
export function loadCrawlIndex(file) {
  const map = new Map()
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return map
  }
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const row = JSON.parse(text)
      if (row && row.platform && row.id) map.set(`${row.platform}:${row.id}`, row)
    } catch {}
  }
  return map
}

/** 已下过且文件仍在盘才算命中——文件被删了要能补回来。 */
export function indexHit(index, platform, id) {
  const row = index.get(`${platform}:${id}`)
  if (!row || !row.file) return null
  try {
    if (statSync(row.file).size > 0) return row
  } catch {}
  return null
}

/**
 * 下载前的筛选：最早发布时间、最低点赞（=喜欢）、最低观看量。
 * 三个条件都为 0 表示不筛。没有发布时间的数据在设了时间筛选时算不合格。
 */
export function passesCrawlFilter(row, { minLike = 0, minView = 0, maxAgeDays = 0, now = Date.now() } = {}) {
  if (minLike > 0 && (Number(row.likeCount) || 0) < minLike) return false
  if (minView > 0 && (Number(row.viewCount) || 0) < minView) return false
  if (maxAgeDays > 0) {
    const ts = Number(row.timestampMs) || 0
    if (!ts) return false
    if (now - ts > maxAgeDays * 86400000) return false
  }
  return true
}

/** 把可选的筛选参数归一成数字：空串/undefined/负数都算「不限」。 */
export function normalizeCrawlFilters(raw = {}) {
  const num = (v) => {
    const n = Number(String(v ?? '').trim())
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  return { minLike: num(raw.minLike), minView: num(raw.minView), maxAgeDays: num(raw.maxAgeDays) }
}

/**
 * 把原始计时压成能直接看懂的摘要：页均/条均/最慢几条/单条平均速率。
 * 注意两件事：①下载是并发的，items 的 ms 之和会大于 downloadMs；
 * ②搜索和下载现在是流水线并行，searchMs 与 downloadMs 有重叠，两者相加大于墙钟。
 */
export function summarizeTimings(timings = {}) {
  const pages = Array.isArray(timings.pages) ? timings.pages : []
  const items = Array.isArray(timings.items) ? timings.items : []
  const ok = items.filter((x) => x.ok !== false)
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, x) => s + (x.ms || 0), 0) / arr.length) : 0)
  const max = (arr) => arr.reduce((m, x) => Math.max(m, x.ms || 0), 0)
  const bytes = ok.reduce((s, x) => s + (x.bytes || 0), 0)
  const itemMs = ok.reduce((s, x) => s + (x.ms || 0), 0)
  return {
    pipeline: true,
    searchMs: timings.searchMs || 0,
    downloadMs: timings.downloadMs || 0,
    pages: { count: pages.length, avgMs: avg(pages), maxMs: max(pages) },
    items: {
      count: items.length,
      ok: ok.length,
      failed: items.length - ok.length,
      avgMs: avg(ok),
      maxMs: max(ok),
      bytesPerSec: itemMs > 0 ? Math.round((bytes / itemMs) * 1000) : 0,
      slowest: ok
        .slice()
        .sort((a, b) => (b.ms || 0) - (a.ms || 0))
        .slice(0, 3)
        .map((x) => ({ id: x.id, ms: x.ms, bytes: x.bytes })),
    },
  }
}

/** 快手有时候只给 HLS 播放列表，直接存下来是一段文本而不是视频。 */
const HLS_MAGIC = '#EXTM3U'

/**
 * 流水线取条：搜索还没结束时，下载协程可能暂时没活干，不能直接收工。
 * 返回 { action: 'take', index } | { action: 'wait' } | { action: 'stop' }。纯函数。
 */
export function pickDownloadTask({ cursor = 0, foundLength = 0, limit = 0, searchDone = true } = {}) {
  const found = Math.max(0, Number(foundLength) || 0)
  const explicit = Number(limit) > 0
  const want = explicit ? Number(limit) : Infinity
  const at = Math.max(0, Number(cursor) || 0)
  // 明确给了 limit 且已认领够数：搜索还在跑也不等了，直接收工。
  if (explicit && at >= want) return { action: 'stop' }
  if (at < Math.min(want, found)) return { action: 'take', index: at }
  return searchDone ? { action: 'stop' } : { action: 'wait' }
}

/** 这条下载错误值不值得重连一次（卡死/截断/服务端 5xx/连接断，值得；4xx 不值得）。 */
export function isRetryableDownloadError(message) {
  const text = String(message || '')
  if (/HTTP 4\d\d/.test(text)) return false
  return /没有任何数据|响应被截断|单条超过|HTTP 5\d\d|fetch failed|socket|ECONNRESET|ETIMEDOUT|aborted/i.test(text)
}

/** 单条连接「停滞」多久算卡死：连续这么久没有任何字节进来就断开重连。
 * 注意这不是按体积算的硬超时——实测快手 CDN 上 78MB 用 75 秒（约 1MB/s）也能正常下完，
 * 硬超时会误杀这种「慢但在推进」的连接；真正该杀的是长时间一个字都不来的。
 */
export const DOWNLOAD_STALL_MS = 15000

/** 单条总预算：极慢但一直有数据的连接也不能无限挂着。 */
export const DOWNLOAD_TOTAL_MS = 300000

/** 读文件头几个字节（用来判断落盘的到底是视频还是播放列表）。 */
function readHead(file, bytes = 256) {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const len = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, len).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd >= 0) try { closeSync(fd) } catch {}
  }
}

/**
 * 把播放列表里的相对分片地址补成绝对地址。纯函数。
 * ffmpeg 吃本地 m3u8 时会把相对路径按 `file://` 解析，所以必须先补全。
 */
export function absolutizePlaylist(text, sourceUrl) {
  const href = String(sourceUrl || '')
  const cut = href.lastIndexOf('/')
  if (cut < 0) return String(text || '')
  const dir = href.slice(0, cut + 1)
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim()
      if (!t || t.startsWith('#')) return line
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return line
      return dir + t
    })
    .join('\n')
}

/** 跑一次 ffmpeg，把 stderr 尾巴带进错误信息（缺参数时看这个）。 */
function runFfmpeg(bin, args, { signal, timeoutMs = 600000 } = {}) {
  return new Promise((res, rej) => {
    execFile(bin, args, { signal, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ')
        err.message = `${err.message}${tail ? `：${tail}` : ''}`
        rej(err)
        return
      }
      res(String(stdout || ''))
    })
  })
}

/**
 * 把已落盘的播放列表合并成 mp4：重写成分片绝对地址的临时 m3u8 → ffmpeg 直拷。
 * 成功返回最终 mp4 的字节数；失败抛错（调用方负责清理）。
 */
async function mergeHlsToMp4(playlistFile, mp4File, sourceUrl, { signal, ffmpeg } = {}) {
  const bin = typeof ffmpeg === 'function' ? ffmpeg() : ffmpeg
  if (!bin) throw new Error('这条是 HLS 播放列表，需要 ffmpeg 合并，但没找到可用的 ffmpeg')
  const list = `${mp4File}.hls.m3u8`
  const tmpOut = `${mp4File}.tmp.mp4`
  try {
    writeFileSync(list, absolutizePlaylist(readFileSync(playlistFile, 'utf8'), sourceUrl), 'utf8')
    // 本地 m3u8 里的分片是 http(s) 绝对地址，必须放开协议白名单，否则 hls demuxer 只认 file/crypto/data。
    // 注意别再传 -user_agent / -headers：这版 ffmpeg 的 CLI 不把 http 协议私有选项当 input option 解析，
    // 会直接报 "Option not found" 而整体失败（实测）。
    await runFfmpeg(bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-f', 'hls', '-i', list,
      '-c', 'copy', tmpOut,
    ], { signal })
    rmSync(mp4File, { force: true })
    renameSync(tmpOut, mp4File)
    return statSync(mp4File).size
  } finally {
    rmSync(list, { force: true })
    rmSync(tmpOut, { force: true })
  }
}

/**
 * 下载一条直链到文件，失败时按 backupUrl 逐个重试；落盘是播放列表就合并成 mp4。
 * stallMs：连续多久没数据算卡死（断开重连）；totalMs：单条总预算。
 */
async function downloadDirect(url, file, {
  signal, backupUrls = [], ffmpeg, stallMs = DOWNLOAD_STALL_MS, totalMs = DOWNLOAD_TOTAL_MS,
} = {}) {
  const headers = { 'user-agent': UA, referer: 'https://www.kuaishou.com/', accept: '*/*' }
  const once = async (target) => {
    const ctrl = new AbortController()
    let last = Date.now()
    const onAbort = () => ctrl.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const watchdog = setInterval(() => {
      if (Date.now() - last > stallMs) ctrl.abort(new Error(`${Math.round(stallMs / 1000)} 秒没有任何数据，断开重连`))
    }, 2000)
    const deadline = totalMs > 0
      ? setTimeout(() => ctrl.abort(new Error(`单条超过 ${Math.round(totalMs / 1000)} 秒，放弃`)), totalMs)
      : null
    try {
      const res = await fetch(target, { headers, signal: ctrl.signal, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const expect = Number(res.headers.get('content-length') || 0)
      const ws = createWriteStream(file)
      let bytes = 0
      const src = Readable.fromWeb(res.body)
      src.on('data', (chunk) => { bytes += chunk.length; last = Date.now() })
      await new Promise((res2, rej) => {
        src.on('error', rej)
        ws.on('error', rej)
        ws.on('finish', res2)
        src.pipe(ws)
      })
      // 响应被掐断时流会「正常」结束：只拿到一小截不能当成功（实测见过 15KB 就 finish）。
      if (expect > 0 && bytes < expect) throw new Error(`只下到 ${bytes}/${expect} 字节，响应被截断`)
      return bytes
    } finally {
      clearInterval(watchdog)
      if (deadline) clearTimeout(deadline)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
  const candidates = [url, ...backupUrls.filter((u) => u && u !== url)]
  let lastErr = null
  for (const target of candidates) {
    try {
      const bytes = await once(target)
      if (readHead(file, 16).startsWith(HLS_MAGIC)) {
        const merged = await mergeHlsToMp4(file, file, target, { signal, ffmpeg })
        return merged
      }
      return bytes
    } catch (err) {
      lastErr = err
      try { rmSync(file, { force: true }) } catch {}
      if (signal?.aborted) break
    }
  }
  throw lastErr || new Error('没有可用的下载地址')
}

class PauseSignal extends Error {
  constructor(reason, detail) {
    super(reason)
    this.code = 'need_human'
    this.reason = reason
    this.detail = detail
  }
}

/**
 * 爬取任务管理器。一个实例管若干 job；job 是异步跑的，start 立刻返回。
 */
export function createCrawler({ stateDir, defaultRoot, platform = 'kuaishou', defaultFilters = {}, log = () => {}, ffmpeg = null }) {
  const indexFile = crawlIndexPath(stateDir)
  const jobsDir = crawlDirName(stateDir)
  const profileDir = join(stateDir, 'kuaishou', 'profile')
  const jobs = new Map()
  const aborts = new Map()

  mkdirSync(jobsDir, { recursive: true })

  const jobPath = (id) => join(jobsDir, `${id}.json`)

  function persist(job) {
    job.updatedAt = new Date().toISOString()
    try {
      writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2) + '\n', 'utf8')
    } catch (err) {
      log(`job 状态写盘失败：${err?.message || err}`)
    }
    return job
  }

  function readJob(id) {
    if (jobs.has(id)) return jobs.get(id)
    try {
      const job = JSON.parse(readFileSync(jobPath(id), 'utf8'))
      jobs.set(id, job)
      return job
    } catch {
      return null
    }
  }

  function listJobs(limit = 10) {
    let names = []
    try {
      names = readdirSync(jobsDir).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    const rows = names
      .map((n) => readJob(n.replace(/\.json$/, '')))
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    // 列表页只要概要：timings / found 这类大字段不进列表，否则状态文件一多就拖死。
    return rows.slice(0, limit).map((job) => ({
      id: job.id,
      keyword: job.keyword,
      status: job.status,
      dir: job.dir,
      limit: job.limit,
      stats: job.stats,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }))
  }

  function newJobId() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    return `${platform}-${stamp}-${randomBytes(2).toString('hex')}`
  }

  function setStatus(job, status, extra = {}) {
    job.status = status
    Object.assign(job, extra)
    log(`[${job.id}] ${status}${job.phase?.word ? ` · ${job.phase.word} · 第 ${job.phase.page} 页` : ''}`)
    return persist(job)
  }

  /**
   * 搜索阶段：同词翻页，把结果塞进 job.found。返回是否已够数。
   * 够不够数按「索引里还没有的」算：重复跑同一个词时，已下过的不占额度，
   * 否则它会以为搜够了，实际只补到一两条（索引命中在下载阶段还会再确认文件在不在盘）。
   */
  async function searchPhase(job, session, signal, index) {
    const words = [job.keyword, ...(job.synonyms || [])].filter(Boolean)
    const seenLocal = new Set(job.found.map((x) => x.id))
    const known = (id) => Boolean(index && index.has(`${platform}:${id}`))
    let fresh = job.found.filter((r) => !known(r.id)).length
    let rateHits = 0

    for (let wi = 0; wi < words.length; wi++) {
      const word = words[wi]
      let pcursor = ''
      let sessionId = ''
      let pages = 0
      const visited = new Set()

      while (pages < job.maxPages) {
        if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'canceled' })
        job.phase = { word, wordIndex: wi, wordCount: words.length, page: pages + 1 }
        persist(job)
        // 每个环节都单独计时：这次的目标不是"能跑"，是"知道时间花在哪"。
        const pageStartedAt = Date.now()
        const foundBefore = job.found.length

        const payload = await session.searchOnce({ keyword: word, pcursor, searchSessionId: sessionId })
        if (payload?.__transport) {
          throw new PauseSignal('transport', `页面内请求失败：${payload.__transport}`)
        }
        const verdict = kuaishouVerdict(payload?.result, payload?.error_msg)
        if (verdict.kind === 'need_login') throw new PauseSignal('login', verdict.message)
        if (verdict.kind === 'captcha') throw new PauseSignal('captcha', verdict.message)
        if (verdict.kind === 'rate_limited') {
          rateHits += 1
          if (rateHits >= 3) throw new PauseSignal('rate_limited', verdict.message)
          log(`限流，等 ${8 * rateHits}s 再试`)
          await sleep(8000 * rateHits)
          continue
        }
        if (verdict.kind !== 'ok') throw new PauseSignal('blocked', verdict.message)
        rateHits = 0

        const rows = kuaishouFeeds(payload)
        job.stats.searched += rows.length
        for (const row of rows) {
          if (seenLocal.has(row.id)) continue
          seenLocal.add(row.id)
          if (!passesCrawlFilter(row, job.filters)) { job.stats.filtered += 1; continue }
          if (!row.source) { job.stats.noSource += 1; continue }
          job.found.push({ ...row, keyword: word })
          if (!known(row.id)) fresh += 1
        }
        job.stats.found = job.found.length
        persist(job)
        job.timings.pages.push({
          word,
          page: pages + 1,
          ms: Date.now() - pageStartedAt,
          rows: rows.length,
          kept: job.found.length - foundBefore,
          dropped: rows.length - (job.found.length - foundBefore),
        })
        log(`「${word}」第 ${pages + 1} 页拿到 ${rows.length} 条，可用 ${job.found.length} 条（筛掉 ${job.stats.filtered}）`)

        if (fresh >= job.limit) return true
        const next = typeof payload?.pcursor === 'string' ? payload.pcursor : ''
        sessionId = typeof payload?.searchSessionId === 'string' ? payload.searchSessionId : sessionId
        if (!next || visited.has(next)) break
        visited.add(next)
        pcursor = next
        pages += 1
        const minDelay = Number(process.env.DSH_KS_PAGE_DELAY_MS) || 1500
        await sleep(minDelay + Math.floor(Math.random() * 1500))
      }
    }
    return fresh >= job.limit
  }

  /**
   * 下载阶段：并发消费 job.found，逐条落盘 + 写索引。
   * 流水线：搜索还在往里追加时，这里边等边下；搜索收工且已下完就退出。
   */
  async function downloadPhase(job, signal, ctx = {}) {
    const searchDone = typeof ctx.searchDone === 'function' ? ctx.searchDone : () => true
    const index = loadCrawlIndex(indexFile)
    const concurrency = Math.max(1, Math.min(8, Number(job.concurrency) || 6))
    let cursor = 0
    let attempted = 0
    let retried = 0

    const worker = async () => {
      for (;;) {
        if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'canceled' })
        // 额度按下「真正尝试下载的条数」算：索引里已下过的跳过不占额度，
        // 否则重复跑一个词时会因为大半被跳过而只补到一两条。
        if (attempted >= job.limit) return
        const pick = pickDownloadTask({
          cursor,
          foundLength: job.found.length,
          limit: 0,
          searchDone: searchDone(),
        })
        if (pick.action === 'stop') return
        if (pick.action === 'wait') { await sleep(300); continue }
        cursor = pick.index + 1
        const row = job.found[pick.index]
        if (!row) { await sleep(200); continue }

        if (indexHit(index, platform, row.id)) {
          job.stats.skipped += 1
          row.status = 'skipped'
          persist(job)
          continue
        }
        attempted += 1

        const file = join(job.dir, kuaishouFileName(row.caption, row.id))
        const itemStartedAt = Date.now()
        try {
          mkdirSync(job.dir, { recursive: true })
          const bytes = await downloadDirect(row.source.url, file, {
            signal, backupUrls: row.source.backupUrl, ffmpeg,
          })
          row.status = 'done'
          row.file = file
          row.bytes = bytes
          job.stats.downloaded += 1
          job.stats.bytes += bytes
          try {
            appendFileSync(indexFile, JSON.stringify({
              platform, id: row.id, file, bytes, keyword: job.keyword,
              caption: row.caption.slice(0, 80), author: row.author,
              at: new Date().toISOString(), jobId: job.id,
            }) + '\n', 'utf8')
          } catch (err) {
            log(`索引写入失败：${err?.message || err}`)
          }
          log(`已下载 ${row.id} → ${bytes} 字节`)
          job.timings.items.push({ id: row.id, ms: Date.now() - itemStartedAt, bytes, ok: true })
        } catch (err) {
          if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'canceled' })
          // 卡死/截断：回队列重连一次，别让一条烂连接把整批拖住。
          if (isRetryableDownloadError(err?.message) && retried < Math.max(3, concurrency)) {
            retried += 1
            cursor -= 1
            job.timings.items.push({ id: row.id, ms: Date.now() - itemStartedAt, bytes: 0, ok: false, retry: true })
            log(`下载重连 ${row.id}（第 ${retried} 次）：${err?.message || err}`)
            await sleep(500)
            continue
          }
          row.status = 'failed'
          row.error = String(err?.message || err)
          job.stats.failed += 1
          job.timings.items.push({ id: row.id, ms: Date.now() - itemStartedAt, bytes: 0, ok: false })
          log(`下载失败 ${row.id}：${row.error}`)
        }
        persist(job)
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker))
    return job.stats.downloaded
  }

  async function runJob(job) {
    const controller = new AbortController()
    aborts.set(job.id, controller)
    const { signal } = controller
    let session = null
    try {
      job.startedAt = new Date().toISOString()
      setStatus(job, 'searching')
      session = await openKuaishouSession({ profileDir, log, signal })

      if (!(await session.hasLogin())) {
        const qr = join(stateDir, 'kuaishou', `login-${job.id}.png`)
        setStatus(job, 'waiting_login', { needHuman: { reason: 'login', at: new Date().toISOString(), qrPath: qr, message: '需要扫码登录快手' } })
        await session.navigate('https://www.kuaishou.com/')
        await sleep(2500)
        const saved = await session.screenshot(qr)
        if (saved) log(`已截登录二维码：${saved}`)
        const deadline = Date.now() + 180000
        let ok = false
        while (Date.now() < deadline) {
          if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'canceled' })
          await sleep(3000)
          if (await session.hasLogin()) { ok = true; break }
        }
        if (!ok) throw new PauseSignal('login', '等待扫码登录超时（3 分钟）')
        job.needHuman = null
        setStatus(job, 'searching')
        log('登录态已就绪，继续爬取')
      }

      // 搜索与下载并行：搜索打 API、下载打 CDN，本来就是两条通道，串着跑等于白等。
      // 搜索一旦出问题（验证码/限流），下载会先把已搜到的条目下完再收工，不浪费。
      const searchStartedAt = Date.now()
      let searchDone = false
      let searchErr = null
      const indexSnapshot = loadCrawlIndex(indexFile)
      const searchTask = (async () => {
        try {
          await searchPhase(job, session, signal, indexSnapshot)
        } catch (err) {
          searchErr = err
        } finally {
          searchDone = true
          job.timings.searchMs = Date.now() - searchStartedAt
        }
      })()

      const warmup = Math.min(4, job.limit)
      while (!searchDone && job.found.length < warmup && !signal.aborted) await sleep(200)

      job.phase = { ...(job.phase || {}), page: 0 }
      setStatus(job, 'downloading', { searchRunning: !searchDone })
      const downloadStartedAt = Date.now()
      let downloadErr = null
      try {
        await downloadPhase(job, signal, { searchDone: () => searchDone })
      } catch (err) {
        downloadErr = err
      } finally {
        job.timings.downloadMs = Date.now() - downloadStartedAt
      }
      await searchTask

      if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'canceled' })
      if (searchErr) throw searchErr
      if (downloadErr) throw downloadErr

      const done = job.stats.downloaded
      const total = job.stats.found
      setStatus(job, done > 0 ? (done >= Math.min(total, job.limit) ? 'done' : 'partial') : 'partial', {
        finishedAt: new Date().toISOString(),
        searchRunning: false,
      })
    } catch (err) {
      if (err instanceof PauseSignal) {
        const qr = join(stateDir, 'kuaishou', `pause-${job.id}.png`)
        try { if (session) await session.screenshot(qr) } catch {}
        setStatus(job, 'paused_need_human', {
          needHuman: { reason: err.reason, message: err.detail || err.reason, at: new Date().toISOString(), qrPath: qr },
          error: err.detail || err.reason,
        })
      } else if (err?.code === 'canceled' || signal.aborted) {
        setStatus(job, 'canceled', { finishedAt: new Date().toISOString() })
      } else {
        setStatus(job, 'failed', { error: String(err?.message || err), finishedAt: new Date().toISOString() })
      }
    } finally {
      try { if (session) session.close() } catch {}
      aborts.delete(job.id)
    }
  }

  return {
    indexPath: indexFile,
    jobsDir,
    profileDir,

    start(opts) {
      const keyword = String(opts.keyword || '').trim()
      if (!keyword) throw Object.assign(new Error('keyword 不能为空'), { code: 'bad_request' })
      const limit = Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : CRAWL_DEFAULT_LIMIT
      const maxPages = Number(opts.maxPages) > 0 ? Math.floor(Number(opts.maxPages)) : CRAWL_DEFAULT_MAX_PAGES
      const root = resolve(String(opts.root || defaultRoot || '').trim() || defaultRoot)
      const dir = join(root, platformLabel(platform), safeDirName(keyword))
      const job = {
        id: newJobId(),
        platform,
        keyword,
        synonyms: Array.isArray(opts.synonyms) ? opts.synonyms.map((s) => String(s).trim()).filter(Boolean) : [],
        root,
        dir,
        limit,
        maxPages,
        concurrency: Number(opts.concurrency) > 0 ? Math.max(1, Math.min(8, Math.floor(Number(opts.concurrency)))) : 6,
        filters: normalizeCrawlFilters({ ...defaultFilters, ...(opts.filters || {}), ...opts }),
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        phase: {},
        stats: { searched: 0, found: 0, filtered: 0, noSource: 0, downloaded: 0, skipped: 0, failed: 0, bytes: 0 },
        timings: { searchMs: 0, downloadMs: 0, pages: [], items: [] },
        found: [],
        needHuman: null,
        error: '',
      }
      jobs.set(job.id, job)
      persist(job)
      runJob(job).catch((err) => log(`job 异常退出：${err?.message || err}`))
      return job
    },

    status(jobId) {
      if (!jobId) return { jobs: listJobs(10) }
      const job = readJob(jobId)
      if (!job) return null
      return {
        id: job.id,
        platform: job.platform,
        keyword: job.keyword,
        status: job.status,
        dir: job.dir,
        limit: job.limit,
        filters: job.filters,
        phase: job.phase,
        stats: job.stats,
        timings: summarizeTimings(job.timings),
        needHuman: job.needHuman,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        items: job.found.slice(0, 200).map((r) => ({
          id: r.id, caption: r.caption.slice(0, 40), author: r.author,
          status: r.status || 'pending', file: r.file || '', bytes: r.bytes || 0, error: r.error || '',
        })),
      }
    },

    resume(jobId) {
      const job = readJob(jobId)
      if (!job) return null
      if (aborts.has(jobId)) return { ok: false, message: '这个任务还在跑' }
      if (!['paused_need_human', 'failed', 'waiting_login'].includes(job.status)) {
        return { ok: false, message: `当前状态 ${job.status} 不需要 resume` }
      }
      job.needHuman = null
      job.error = ''
      job.status = 'queued'
      persist(job)
      runJob(job).catch((err) => log(`job 异常退出：${err?.message || err}`))
      return { ok: true, job: job.id, status: job.status }
    },

    cancel(jobId) {
      const job = readJob(jobId)
      if (!job) return null
      const controller = aborts.get(jobId)
      if (controller) controller.abort(new Error('已取消'))
      job.status = 'canceled'
      job.finishedAt = new Date().toISOString()
      persist(job)
      return { ok: true, job: jobId, status: 'canceled' }
    },
  }
}
