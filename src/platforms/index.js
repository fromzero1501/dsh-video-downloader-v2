/**
 * 平台适配器注册表。
 *
 * 一个适配器只需要实现 crawl 需要的动作：
 *   id / label / needsBrowser
 *   supportsLikeFilter(source)          该入口能不能拿到点赞量
 *   profileDir(stateDir)                浏览器 profile 落点
 *   openSession({stateDir, log, signal}) 返回会话对象（纯 HTTP 平台可以返回 null）
 *   ensureLogin(session, ctx)           {ok} 或 {ok:false, reason, message}
 *   searchKeyword(session, {keyword, cursor, sessionId}) → {rows, nextCursor, nextSessionId, verdict}
 *   listCreator(session, {creatorId, cursor})            → {rows, nextCursor, authorName, verdict}
 *   canDownload(row) / fileName(row)
 *   download?(row, {file, dir, signal, ffmpeg})          只有需要自解析播放地址的平台才实现
 *
 * verdict.kind 取值与 crawl.js 对齐：ok | rate_limited | need_login | captcha | blocked | failed。
 */

import { createBilibiliAdapter } from './bilibili.js'
import { createDouyinAdapter } from './douyin.js'
import { createKuaishouAdapter } from './kuaishou.js'

export function createPlatformRegistry({ resolveBilibili = null, downloadBilibili = null, ffmpeg = null, quality } = {}) {
  const list = [
    createKuaishouAdapter(),
    createBilibiliAdapter({ resolveBilibili, downloadBilibili, ffmpeg, quality }),
    createDouyinAdapter(),
  ]
  const map = new Map(list.map((a) => [a.id, a]))
  return {
    list,
    ids: list.map((a) => a.id),
    get(id) {
      return map.get(String(id || '').toLowerCase()) || null
    },
  }
}

/**
 * 从任意输入猜平台：主页链接、作品链接、裸 bvid / sec_uid 都试一遍。
 */
export function detectCrawlPlatform(input) {
  const text = String(input || '').trim()
  if (/bilibili\.com|b23\.tv/i.test(text) || /^BV1[A-Za-z0-9]{9}$/i.test(text)) return 'bilibili'
  if (/kuaishou\.com|kwai\.com|chenzhongtech\.com/i.test(text)) return 'kuaishou'
  if (/douyin\.com|iesdouyin\.com/i.test(text)) return 'douyin'
  if (/^MS4wLjABAAAA[A-Za-z0-9_\-]+$/.test(text)) return 'douyin'
  return ''
}
