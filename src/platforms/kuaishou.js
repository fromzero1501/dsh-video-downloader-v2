/**
 * 快手适配器：把现有的浏览器通道（有头 Edge + 持久 profile + 页面内 $encode 签名）
 * 包装成 crawl.js 认识的统一契约。
 *
 * 这里不实现 download：快手 manifest 给的是单文件 mp4 直链，直接交给 crawl 内置的
 * downloadDirect（含 HLS 回落与停滞重连）。只有需要自解析播放地址的平台（如 B站）
 * 才提供 download。
 */

import { join } from 'node:path'
import {
  kuaishouFeeds,
  kuaishouFileName,
  kuaishouProfileFeeds,
  kuaishouVerdict,
  openKuaishouSession,
} from '../kuaishou.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 统一 verdict：把传输层错误也算进去，避免把「页面没就绪」当成空结果。 */
function verdictOf(payload) {
  if (payload?.__transport) {
    return { kind: 'blocked', message: `页面内请求失败：${payload.__transport}` }
  }
  if (payload?.__noRealm) {
    return { kind: 'blocked', message: '签名环境未捕获（页面没加载完或登录态缺失）' }
  }
  return kuaishouVerdict(payload?.result, payload?.error_msg)
}

export function createKuaishouAdapter() {
  return {
    id: 'kuaishou',
    label: '快手',
    needsBrowser: true,

    supportsLikeFilter() {
      return true
    },

    profileDir(stateDir) {
      return join(stateDir, 'kuaishou', 'profile')
    },

    async openSession({ stateDir, log = () => {}, signal, blockMedia = false }) {
      return openKuaishouSession({ profileDir: join(stateDir, 'kuaishou', 'profile'), log, signal, blockMedia })
    },

    /**
     * 登录保障：未登录就截二维码等人工扫码，最长 3 分钟。
     * onNeedHuman 由 crawl 传入，用来把 job 置成 waiting_login（含截图路径）。
     */
    async ensureLogin(session, { stateDir, jobId, log = () => {}, signal, onNeedHuman = () => {}, waitMs = 180000 }) {
      if (!session) return { ok: true }
      if (await session.hasLogin()) return { ok: true }
      const qr = join(stateDir, 'kuaishou', `login-${jobId}.png`)
      onNeedHuman({
        reason: 'login',
        at: new Date().toISOString(),
        qrPath: qr,
        message: '需要扫码登录快手',
      })
      await session.navigate('https://www.kuaishou.com/')
      await sleep(2500)
      const saved = await session.screenshot(qr)
      if (saved) log(`已截登录二维码：${saved}`)
      const budget = Math.max(30000, Number(waitMs) || 180000)
      const deadline = Date.now() + budget
      while (Date.now() < deadline) {
        if (signal?.aborted) return { ok: false, reason: 'canceled', message: '已取消' }
        await sleep(3000)
        if (await session.hasLogin()) return { ok: true }
      }
      return { ok: false, reason: 'login', message: `等待扫码登录超时（${Math.round(budget / 1000)} 秒）` }
    },

    /** 关键词搜索：cursor 就是接口的 pcursor，空串表示第一页。 */
    async searchKeyword(session, { keyword, cursor = '', sessionId = '' }) {
      const payload = await session.searchOnce({
        keyword,
        pcursor: String(cursor || ''),
        searchSessionId: String(sessionId || ''),
      })
      const verdict = verdictOf(payload)
      if (verdict.kind !== 'ok') return { rows: [], nextCursor: '', verdict }
      return {
        rows: kuaishouFeeds(payload),
        nextCursor: typeof payload?.pcursor === 'string' ? payload.pcursor : '',
        nextSessionId: typeof payload?.searchSessionId === 'string' ? payload.searchSessionId : sessionId,
        verdict: { kind: 'ok', message: '' },
      }
    },

    /** 作者主页作品：cursor 是 pcursor。接口结构未在官方文档里，容器位置做了兜底。 */
    async listCreator(session, { creatorId, cursor = '' }) {
      const payload = await session.profileFeedOnce({ userId: creatorId, pcursor: String(cursor || '') })
      const verdict = verdictOf(payload)
      if (verdict.kind !== 'ok') return { rows: [], nextCursor: '', verdict }
      const { rows, pcursor } = kuaishouProfileFeeds(payload)
      return {
        rows,
        nextCursor: pcursor || '',
        authorName: rows[0]?.author || '',
        verdict: { kind: 'ok', message: '' },
      }
    },

    canDownload(row) {
      return Boolean(row?.source?.url)
    },

    fileName(row) {
      return kuaishouFileName(row?.caption, row?.id)
    },

    /** 主页链接 → userId；短链要浏览器解析，这里只认直接形态。 */
    resolveCreatorId(input) {
      const text = String(input || '').trim()
      const m = text.match(/(?:kuaishou\.com|kwai\.com)\/(?:profile|user)\/([A-Za-z0-9_-]+)/)
      if (m) return { creatorId: m[1], name: '' }
      if (/^[A-Za-z0-9_-]{6,}$/.test(text) && !/^https?:/i.test(text)) {
        return { creatorId: text, name: '' }
      }
      return null
    },
  }
}
