import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  apply,
  analyze,
  classifyLuxError,
  classifyYtDlpError,
  detectSite,
  douyinVideoId,
  extractBvid,
  extractPage,
  genericBackendOrder,
  getExt,
  getQuality,
  isMedia,
  isPlaylistUrl,
  isResolvablePage,
  douyinShortLink,
  luxArgs,
  luxParseJson,
  luxQualities,
  luxTargetHeight,
  normalizeDouyinUrl,
  pickLuxOutput,
  pickLuxStream,
  resolveDouyinInput,
  outDirOf,
  pickAudioTrack,
  pickVideoTrack,
  routeFor,
  sanitizeName,
  setEnvInsensitive,
} from '../src/index.js'
import {
  indexHit,
  absolutizePlaylist,
  DOWNLOAD_STALL_MS,
  isRetryableDownloadError,
  loadCrawlIndex,
  normalizeCrawlFilters,
  passesCrawlFilter,
  pickDownloadTask,
  platformLabel,
  refererFor,
  safeDirName,
  summarizeTimings,
} from '../src/crawl.js'
import {
  kuaishouFeeds,
  kuaishouFileName,
  kuaishouIsHlsUrl,
  kuaishouPickSource,
  kuaishouVerdict,
} from '../src/kuaishou.js'
import { createPlatformRegistry, detectCrawlPlatform } from '../src/platforms/index.js'
import { BILI_DM_PARAMS, biliRow, cleanBiliTitle, createBilibiliAdapter, wbiSign } from '../src/platforms/bilibili.js'
import { createDouyinAdapter } from '../src/platforms/douyin.js'
import {
  decodeDouyinPayloads,
  douyinExtractAwemes,
  douyinFileName,
  douyinPageState,
  douyinResolveCreatorId,
  douyinRow,
  douyinVerdict,
} from '../src/platforms/douyin.js'
import { buildRequest, cookieStringOf, fakeMsToken, fingerprintOf } from '../src/platforms/douyin/http.js'
import { isSearchPath, needsWebSignature, signWebQuery, uifidFromCookie } from '../src/platforms/douyin/websign.js'

// Minimal ctx: enough for `apply` to register tools and for the pure tools to run.
function mockCtx() {
  const tools = []
  return {
    tools: {
      register(t) {
        tools.push(t)
      },
    },
    all: tools,
    get(name) {
      return tools.find((t) => t.name === name)
    },
  }
}

test('isMedia detects mp4 and bilivideo m4s, rejects plain pages', () => {
  assert.equal(isMedia('https://example.com/video.mp4'), true)
  assert.equal(isMedia('https://bilivideo.com/foo.m4s'), true)
  assert.equal(isMedia('https://example.com/page'), false)
})

test('getQuality extracts 1080P from height param and 4K from high bitrate', () => {
  assert.equal(getQuality('https://example.com/video.mp4?height=1080&foo=bar'), '1080P')
  assert.equal(getQuality('https://example.com/video.mp4?bitrate=9000000'), '4K')
})

test('getExt returns m3u8 for .m3u8 URLs and mpd for .mpd URLs', () => {
  assert.equal(getExt('https://example.com/stream/master.m3u8'), 'm3u8')
  assert.equal(getExt('https://example.com/stream/manifest.mpd'), 'mpd')
})

test('detectSite identifies the four supported hosts plus short links', () => {
  assert.equal(detectSite('https://www.bilibili.com/video/BV1xx411c7mD'), 'bilibili')
  assert.equal(detectSite('https://b23.tv/abcdefg'), 'bilibili')
  assert.equal(detectSite('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube')
  assert.equal(detectSite('https://www.douyin.com/video/123'), 'douyin')
  assert.equal(detectSite('https://www.xiaohongshu.com/explore/abc'), 'xiaohongshu')
  assert.equal(detectSite('https://example.com/page'), 'other')
})

test('extractBvid accepts bare ids, page URLs and share text', () => {
  assert.equal(extractBvid('BV1GJ411x7h7'), 'BV1GJ411x7h7')
  assert.equal(extractBvid('https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333'), 'BV1GJ411x7h7')
  assert.equal(extractBvid('看这个 https://b23.tv/abcd 好活'), '')
  assert.equal(extractBvid('https://example.com/nope'), '')
})

test('extractPage reads ?p= and defaults to 1', () => {
  assert.equal(extractPage('https://www.bilibili.com/video/BV1GJ411x7h7?p=3'), 3)
  assert.equal(extractPage('https://www.bilibili.com/video/BV1GJ411x7h7'), 1)
  assert.equal(extractPage('BV1GJ411x7h7'), 1)
})

test('isResolvablePage separates page links from direct media links', () => {
  assert.equal(isResolvablePage('BV1GJ411x7h7'), true)
  assert.equal(isResolvablePage('https://www.bilibili.com/video/BV1GJ411x7h7'), true)
  assert.equal(isResolvablePage('https://b23.tv/abcdefg'), true)
  assert.equal(isResolvablePage('https://upos-sz-mirrorcos.bilivideo.com/x.m4s'), false)
  assert.equal(isResolvablePage('https://www.bilibili.com/read/cv123'), false)
  assert.equal(isResolvablePage('https://example.com/video.mp4'), false)
})

test('analyze distinguishes page / direct / unknown and exposes the backend', () => {
  const page = analyze('https://www.bilibili.com/video/BV1GJ411x7h7')
  assert.equal(page.kind, 'page')
  assert.equal(page.backend, 'bilibili')
  const other = analyze('https://example.com/watch/12345')
  assert.equal(other.kind, 'page')
  assert.equal(other.backend, 'ytdlp')
  assert.equal(analyze('https://example.com/a.mp4').kind, 'direct')
  assert.equal(analyze('https://example.com/a.mp4').backend, 'direct')
  assert.equal(analyze('not a url').kind, 'unknown')
  assert.equal(analyze('https://www.bilibili.com/read/cv123').backend, 'unsupported')
})

test('routeFor picks one engine per input', () => {
  assert.equal(routeFor('BV1GJ411x7h7'), 'bilibili')
  assert.equal(routeFor('https://b23.tv/abcdefg'), 'bilibili')
  assert.equal(routeFor('https://example.com/a.mp4'), 'direct')
  assert.equal(routeFor('https://www.douyin.com/video/123'), 'ytdlp')
  assert.equal(routeFor('https://www.youtube.com/watch?v=BaW_jenozKc'), 'ytdlp')
  assert.equal(routeFor('https://www.bilibili.com/read/cv123'), 'unsupported')
  assert.equal(routeFor('nothing here'), 'none')
})

test('classifyYtDlpError maps stderr onto stable error codes', () => {
  assert.equal(classifyYtDlpError('ERROR: Unsupported URL: https://x.y/z'), 'unsupported')
  assert.equal(classifyYtDlpError('ERROR: Sign in to confirm you are not a bot'), 'need_login')
  assert.equal(classifyYtDlpError('ERROR: [youtube] x: This video is unavailable'), 'unavailable')
  assert.equal(classifyYtDlpError('ERROR: HTTP Error 403: Forbidden'), 'blocked')
  assert.equal(classifyYtDlpError('ERROR: [generic] page: HTTP Error 404: Not Found'), 'not_found')
  assert.equal(classifyYtDlpError('ERROR: ffmpeg not found. Please install or provide the path'), 'missing_ffmpeg')
  assert.equal(classifyYtDlpError('ERROR: Unable to download webpage: timed out'), 'network')
  assert.equal(classifyYtDlpError('something odd'), 'download_failed')
})

test('pickVideoTrack prefers the highest id and an avc codec', () => {
  const videos = [
    { id: 32, codecid: 13, height: 480, baseUrl: 'a', codecs: 'av01' },
    { id: 32, codecid: 7, height: 480, baseUrl: 'b', codecs: 'avc1' },
    { id: 16, codecid: 7, height: 360, baseUrl: 'c', codecs: 'avc1' },
  ]
  assert.equal(pickVideoTrack(videos).baseUrl, 'b')
  assert.equal(pickVideoTrack(videos, 'worst').baseUrl, 'c')
  assert.equal(pickVideoTrack(videos, '16').baseUrl, 'c')
  assert.equal(pickVideoTrack([]), null)
})

test('pickAudioTrack takes the highest bandwidth and tolerates missing values', () => {
  const audios = [
    { id: 30216, bandwidth: 43962 },
    { id: 30280, bandwidth: 203786 },
    { id: 30232 },
  ]
  assert.equal(pickAudioTrack(audios).id, 30280)
  assert.equal(pickAudioTrack([]), null)
})

test('sanitizeName strips filesystem-hostile characters and caps length', () => {
  assert.equal(sanitizeName('a/b:c*?"<>|d'), 'a_b_c_d')
  assert.equal(sanitizeName('   '), 'media')
  assert.ok(sanitizeName('x'.repeat(200)).length <= 80)
})

test('apply registers every tool with valid JSON-Schema parameters', () => {
  const ctx = mockCtx()
  apply(ctx)
  const names = ctx.all.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'video_analyze',
    'video_crawl',
    'video_crawl_cancel',
    'video_crawl_resume',
    'video_crawl_status',
    'video_download',
    'video_quality_parse',
    'video_resolve',
  ])
  // 下载类工具必填 url；爬取类必填 jobId。video_crawl 的 keyword/creator 二选一，
  // 由 execute 里按 source 校验，schema 上不设 required（否则 creator 入口会缺参）。
  const requiredByTool = {
    video_crawl: [],
    video_crawl_cancel: ['jobId'],
    video_crawl_resume: ['jobId'],
    video_crawl_status: [],
  }
  for (const t of ctx.all) {
    const required = requiredByTool[t.name] || ['url']
    assert.equal(typeof t.description, 'string')
    assert.equal(t.parameters.type, 'object')
    assert.deepEqual(t.parameters.required || [], required)
    for (const key of required) assert.equal(t.parameters.properties[key].type, 'string')
    assert.equal(t.parameters.additionalProperties, undefined)
    assert.equal(t.output.schema.type, 'string')
    assert.equal(typeof t.output.render, 'function')
  }
  const download = ctx.get('video_download')
  assert.equal(download.parameters.properties.headers.type, 'object')
  assert.equal(download.parameters.properties.headers.additionalProperties, true)
  assert.deepEqual(
    download.output.render({}, 'hello'),
    [{ type: 'text', text: 'hello' }],
  )
})

test('video_quality_parse returns { quality: "720P", ext: "mp4" } for a sample URL', async () => {
  const ctx = mockCtx()
  apply(ctx)
  const tool = ctx.get('video_quality_parse')
  assert.ok(tool, 'video_quality_parse tool registered')
  const out = await tool.execute({ url: 'https://example.com/video.mp4?height=720' })
  assert.deepEqual(JSON.parse(out), { quality: '720P', ext: 'mp4' })
})

test('video_analyze reports kind=page for a Bilibili page link', async () => {
  const ctx = mockCtx()
  apply(ctx)
  const tool = ctx.get('video_analyze')
  const out = JSON.parse(await tool.execute({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }))
  assert.equal(out.site, 'bilibili')
  assert.equal(out.kind, 'page')
  assert.equal(out.isMedia, false)
})

test('video_download reports a readable error for a non-video Bilibili link', async () => {
  const ctx = mockCtx()
  apply(ctx)
  const tool = ctx.get('video_download')
  const out = JSON.parse(await tool.execute({ url: 'https://www.bilibili.com/read/cv123' }))
  assert.equal(out.error, 'unsupported')
})

test('douyinVideoId reads the id out of every shape Douyin shares', () => {
  const id = '7575127409680256955'
  assert.equal(douyinVideoId(id), id)
  assert.equal(douyinVideoId(`https://www.douyin.com/user/self?modal_id=${id}&showTab=like`), id)
  assert.equal(douyinVideoId(`https://www.douyin.com/video/${id}`), id)
  assert.equal(douyinVideoId(`https://www.iesdouyin.com/share/video/${id}/?region=CN`), id)
  assert.equal(douyinVideoId(`看看这个 https://www.douyin.com/video/${id} 复制打开抖音`), id)
  assert.equal(douyinVideoId('https://www.douyin.com/user/self?showTab=like'), '')
})

test('normalizeDouyinUrl turns a profile-with-modal link into a canonical video page', () => {
  const id = '7575127409680256955'
  assert.equal(
    normalizeDouyinUrl(`https://www.douyin.com/user/self?modal_id=${id}&showTab=like`),
    `https://www.douyin.com/video/${id}`,
  )
  // non-Douyin input is handed back untouched
  assert.equal(normalizeDouyinUrl('https://example.com/a.mp4'), 'https://example.com/a.mp4')
})

test('analyze exposes normalizedUrl for a Douyin profile-with-modal link', () => {
  const id = '7575127409680256955'
  const out = analyze(`https://www.douyin.com/user/self?modal_id=${id}&showTab=like`)
  assert.equal(out.site, 'douyin')
  assert.equal(out.kind, 'page')
  assert.equal(out.normalizedUrl, `https://www.douyin.com/video/${id}`)
})

test('routeFor sends playlists to the merging backend instead of raw streaming', () => {
  assert.equal(isPlaylistUrl('https://example.com/live/index.m3u8'), true)
  assert.equal(isPlaylistUrl('https://example.com/live/index.mpd'), true)
  assert.equal(isPlaylistUrl('https://example.com/a.mp4'), false)
  assert.equal(routeFor('https://example.com/live/index.m3u8'), 'ytdlp')
  assert.equal(routeFor('https://example.com/live/index.mpd'), 'ytdlp')
  assert.equal(routeFor('https://example.com/a.mp4'), 'direct')
})

test('classifyYtDlpError treats the Argus rejection as blocked', () => {
  assert.equal(classifyYtDlpError('Blocked by ArgusSecurityPlugin Uifid Not Found'), 'blocked')
  assert.equal(classifyYtDlpError('HTTP Error 403: Forbidden'), 'blocked')
})


test('outDirOf: only directory-shaped outPath counts as a directory', () => {
  assert.equal(outDirOf(undefined), null)
  assert.equal(outDirOf(''), null)
  assert.equal(outDirOf('   '), null)
  assert.equal(outDirOf('C:\\no\\such\\clip.mp4'), null)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-outdir-'))
  try {
    assert.equal(outDirOf(dir), resolve(dir))
    assert.equal(outDirOf(dir + '/'), resolve(dir))
    assert.equal(outDirOf(dir + '\\'), resolve(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a share sentence with a v.douyin.com short link still counts as Douyin', () => {
  const share =
    '5.15 复制打开抖音，看看【香香在新疆的作品】红枣大丰收 https://v.douyin.com/bvWiDnyQSXI/ p@D.Uy Gvf:/ :4pm 08/07'
  assert.equal(detectSite(share), 'douyin')
  assert.equal(douyinShortLink(share), 'https://v.douyin.com/bvWiDnyQSXI/')
  assert.equal(douyinShortLink('https://v.douyin.com/abcDEF12/'), 'https://v.douyin.com/abcDEF12/')
  assert.equal(douyinShortLink('https://www.douyin.com/video/7700634421217620730'), '')
})

test('resolveDouyinInput answers a canonical page for a bare id and passes others through', async () => {
  const byId = await resolveDouyinInput('7700634421217620730')
  assert.equal(byId.id, '7700634421217620730')
  assert.equal(byId.pageUrl, 'https://www.douyin.com/video/7700634421217620730')
  assert.equal(byId.via, 'id')
  assert.equal(await resolveDouyinInput('https://example.com/clip.mp4'), null)
})

// ------------------------------------------------------------------ lux backend

test('genericBackendOrder: auto puts yt-dlp first, lux pref flips it, Douyin never gets lux', () => {
  assert.deepEqual(genericBackendOrder('auto'), ['ytdlp', 'lux'])
  assert.deepEqual(genericBackendOrder('lux'), ['lux', 'ytdlp'])
  assert.deepEqual(genericBackendOrder('ytdlp'), ['ytdlp'])
  assert.deepEqual(genericBackendOrder(undefined), ['ytdlp', 'lux'])
  assert.deepEqual(genericBackendOrder('nonsense'), ['ytdlp', 'lux'])
  assert.deepEqual(genericBackendOrder('lux', { douyin: true }), ['ytdlp'])
})

test('classifyLuxError maps lux output onto the shared error codes', () => {
  assert.equal(classifyLuxError('exec: "ffmpeg": executable file not found in %PATH%'), 'missing_ffmpeg')
  assert.equal(classifyLuxError('unsupported URL: https://example.com/x'), 'unsupported')
  assert.equal(classifyLuxError('get video info failed: no available streams'), 'not_found')
  assert.equal(classifyLuxError('this video need login'), 'need_login')
  assert.equal(classifyLuxError('HTTP 403 Forbidden'), 'blocked')
  assert.equal(classifyLuxError('dial tcp: lookup example.com: no such host'), 'network')
  assert.equal(classifyLuxError('something else broke'), 'download_failed')
})

test('luxParseJson tolerates progress noise and rejects broken payloads', () => {
  const one = luxParseJson('downloading...\n[{"title":"T","streams":{}}]\ndone')
  assert.equal(one.length, 1)
  assert.equal(one[0].title, 'T')
  assert.deepEqual(luxParseJson('not json at all'), [])
  assert.deepEqual(luxParseJson(''), [])
  assert.equal(luxParseJson('{"title":"single"}').length, 1)
})

const LUX_ENTRY = {
  title: 'demo',
  streams: {
    '16-7': { id: '16-7', quality: '流畅 360P avc1.64001E', size: 7672578, ext: 'mp4', parts: [{}, {}], NeedMux: true },
    '32-12': { id: '32-12', quality: '清晰 480P hvc1.1.6.L120.90', size: 9000000, ext: 'mp4', parts: [{}], NeedMux: true },
    '80-7': { id: '80-7', quality: '高清 1080P avc1', size: 40000000, ext: 'mp4', parts: [{}], NeedMux: true },
    odd: { id: 'odd', quality: 'unknown', size: 1234, ext: 'flv', parts: [] },
  },
}

test('luxQualities sorts by height then size and keeps lux stream ids', () => {
  const list = luxQualities(LUX_ENTRY)
  assert.deepEqual(list.map((x) => x.formatId), ['80-7', '32-12', '16-7', 'odd'])
  assert.equal(list[0].height, 1080)
  assert.equal(list[0].needMux, true)
  assert.equal(list[3].height, null)
  assert.equal(list[3].filesize, 1234)
  assert.deepEqual(luxQualities({}), [])
})

test('luxTargetHeight maps best/worst/Bilibili numeric ids/raw heights', () => {
  assert.equal(luxTargetHeight('best'), Infinity)
  assert.equal(luxTargetHeight(''), Infinity)
  assert.equal(luxTargetHeight('worst'), 0)
  assert.equal(luxTargetHeight('64'), 720)
  assert.equal(luxTargetHeight('480p'), 480)
  assert.equal(luxTargetHeight('720'), 720)
})

test('pickLuxStream respects best/worst/ceiling and degrades to the closest reachable stream', () => {
  const list = luxQualities(LUX_ENTRY)
  assert.equal(pickLuxStream(list, 'best').formatId, '80-7')
  assert.equal(pickLuxStream(list, 'worst').formatId, '16-7')
  assert.equal(pickLuxStream(list, '64').formatId, '32-12')
  assert.equal(pickLuxStream(list, '16').formatId, '16-7')
  const no480 = list.filter((x) => x.formatId !== '32-12')
  assert.equal(pickLuxStream(no480, '64').formatId, '16-7')
  assert.equal(pickLuxStream([], 'best'), null)
})

test('luxArgs builds the download command with the URL last', () => {
  assert.deepEqual(luxArgs('https://example.com/v/1', { format: '32-12', outDir: 'D:\\out', name: 'demo' }), [
    '-s',
    '-f',
    '32-12',
    '-o',
    'D:\\out',
    '-O',
    'demo',
    'https://example.com/v/1',
  ])
  assert.deepEqual(luxArgs('u', { cookies: '/tmp/c.txt' }), ['-s', '-c', '/tmp/c.txt', 'u'])
  assert.deepEqual(luxArgs('u'), ['-s', 'u'])
})

test('setEnvInsensitive keeps a single PATH key (regression: lux lost ffmpeg)', () => {
  const env = { Path: 'C:\\a;C:\\b', FOO: '1' }
  setEnvInsensitive(env, 'PATH', 'D:\\ff;C:\\a;C:\\b')
  assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH'), ['PATH'])
  assert.equal(env.PATH, 'D:\\ff;C:\\a;C:\\b')
  assert.equal(env.FOO, '1')
  // 大小写不同的旧键必须一并去掉，否则子进程可能取到旧值
  setEnvInsensitive(env, 'http_proxy', 'http://127.0.0.1:7890')
  assert.deepEqual(Object.keys(env).filter((k) => k.toLowerCase() === 'http_proxy'), ['http_proxy'])
})

test('pickLuxOutput only accepts files this run wrote, and prefers the exact base name', () => {  const dir = mkdtempSync(join(tmpdir(), 'dsh-lux-out-'))
  try {
    const stale = join(dir, 'demo.mp4')
    writeFileSync(stale, 'old')
    const past = (Date.now() - 3600_000) / 1000
    utimesSync(stale, past, past)
    // 目录里只有一小时前的同名文件：不算本次结果
    assert.equal(pickLuxOutput(dir, 'demo', { since: Date.now() - 60_000 }), '')

    const fresh = join(dir, 'demo.mp4')
    writeFileSync(fresh, 'new-bytes')
    assert.equal(pickLuxOutput(dir, 'demo', { since: Date.now() - 60_000 }), fresh)

    // 同前缀的另一条视频 + 半成品都不能被当成结果
    writeFileSync(join(dir, 'demo live.mp4'), 'other-video')
    writeFileSync(join(dir, 'demo.webm.part'), 'partial')
    assert.equal(pickLuxOutput(dir, 'demo', { since: Date.now() - 60_000 }), fresh)

    // 没有 since 限制时也优先精确同名（体积/时间更大的那条优先）
    assert.equal(pickLuxOutput(dir, 'demo'), fresh)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('platformLabel and safeDirName keep Chinese but strip illegal characters', () => {
  assert.equal(platformLabel('kuaishou'), '快手')
  assert.equal(platformLabel('BILIBILI'), 'B站')
  assert.equal(platformLabel('douyin'), '抖音')
  assert.equal(platformLabel('something'), 'something')
  assert.equal(safeDirName('和田大枣'), '和田大枣')
  assert.equal(safeDirName('a/b:c*d?"e"<f>|g'), 'a b c d e f g')
  assert.equal(safeDirName('   '), '未命名')
  assert.equal(safeDirName('name.'), 'name')
})

test('kuaishouVerdict maps the result codes we actually hit', () => {
  assert.equal(kuaishouVerdict(1).kind, 'ok')
  assert.equal(kuaishouVerdict(2).kind, 'rate_limited')
  assert.equal(kuaishouVerdict(50).kind, 'need_login')
  assert.equal(kuaishouVerdict(109).kind, 'need_login')
  assert.equal(kuaishouVerdict(400002).kind, 'captcha')
  assert.equal(kuaishouVerdict('abc').kind, 'failed')
  assert.match(kuaishouVerdict(2, '操作太快了').message, /操作太快了/)
})

test('kuaishouPickSource takes the largest representation and keeps backups', () => {
  const photo = {
    manifest: {
      adaptationSet: [
        { representation: [{ url: 'https://cdn/low.mp4', size: 100, backupUrl: ['https://cdn/low-b.mp4'] }] },
        { representation: [
          { url: 'https://cdn/high.mp4', size: 900, width: 720, height: 1280, codecs: 'avc1' },
          { url: 'not-a-url', size: 5000 },
        ] },
      ],
    },
  }
  const src = kuaishouPickSource(photo)
  assert.equal(src.url, 'https://cdn/high.mp4')
  assert.equal(src.size, 900)
  assert.equal(src.height, 1280)
  assert.deepEqual(src.backupUrl, [])
  assert.equal(kuaishouPickSource({}), null)
  assert.equal(kuaishouPickSource({ manifest: { adaptationSet: [] } }), null)
})

test('kuaishouPickSource prefers a direct mp4 over a bigger HLS variant', () => {
  // 快手有时只给 m3u8：能拿 mp4 就拿 mp4，拿不到才回落到 HLS 并打上标记
  const mixed = {
    manifest: {
      adaptationSet: [
        { representation: [
          { url: 'https://cdn/v.m3u8?pkey=AA', size: 0 },
          { url: 'https://cdn/v.mp4', size: 1200 },
        ] },
        { representation: [{ url: 'https://cdn/v-hd.m3u8', size: 9999 }] },
      ],
    },
  }
  const picked = kuaishouPickSource(mixed)
  assert.equal(picked.url, 'https://cdn/v.mp4')
  assert.equal(picked.hls, false)

  const hlsOnly = {
    manifest: { adaptationSet: [{ representation: [{ url: 'https://cdn/only.m3u8?ftt=R', size: 7 }] }] },
  }
  const fallback = kuaishouPickSource(hlsOnly)
  assert.equal(fallback.url, 'https://cdn/only.m3u8?ftt=R')
  assert.equal(fallback.hls, true)

  assert.equal(kuaishouIsHlsUrl('https://cdn/a.m3u8?x=1'), true)
  assert.equal(kuaishouIsHlsUrl('https://cdn/hls/seg.ts'), true)
  assert.equal(kuaishouIsHlsUrl('https://cdn/a.mp4'), false)
})

test('absolutizePlaylist rewrites segments and leaves tags and absolute urls alone', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXTINF:8.333333,',
    '5194339438801540507_5d33ae2c_5687_hlsob.00000.ts?ftt=R&x-ks-pt',
    'https://other.cdn/abs.ts',
    '',
  ].join('\n')
  const out = absolutizePlaylist(text, 'https://v.cdn/ks/path/list.m3u8?pkey=AA')
  const lines = out.split('\n')
  assert.equal(lines[0], '#EXTM3U')
  assert.equal(lines[1], '#EXT-X-VERSION:3')
  assert.equal(
    lines[3],
    'https://v.cdn/ks/path/5194339438801540507_5d33ae2c_5687_hlsob.00000.ts?ftt=R&x-ks-pt',
  )
  assert.equal(lines[4], 'https://other.cdn/abs.ts')
})

test('kuaishouFeeds normalises like/view/timestamp and falls back to realLikeCount', () => {
  const rows = kuaishouFeeds({
    result: 1,
    feeds: [
      {
        photo: {
          id: 'aaa', caption: '#和田大枣 好枣', duration: 8966, viewCount: 85132, likeCount: 410,
          timestamp: 1791652700711,
          manifest: { adaptationSet: [{ representation: [{ url: 'https://cdn/x.mp4', size: 10 }] }] },
        },
        author: { name: '小飞家' },
      },
      { photo: { id: 'bbb', caption: 'x', viewCount: 10, realLikeCount: 7, timestamp: 1791652700 } },
      { photo: { caption: 'no id' } },
    ],
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].likeCount, 410)
  assert.equal(rows[0].viewCount, 85132)
  assert.equal(rows[0].timestampMs, 1791652700711)
  assert.equal(rows[0].author, '小飞家')
  assert.equal(rows[0].source.url, 'https://cdn/x.mp4')
  assert.equal(rows[1].likeCount, 7)
  assert.equal(rows[1].timestampMs, 1791652700000)
  assert.equal(rows[1].source, null)
})

test('kuaishouFileName drops hashtags and illegal characters', () => {
  const name = kuaishouFileName('#和田大枣 #助农 好枣/真甜', 'aaa')
  assert.match(name, /^和田大枣 助农 好枣 真甜 \[aaa\]\.mp4$/)
  assert.match(kuaishouFileName('', 'bbb'), /^kuaishou \[bbb\]\.mp4$/)
  assert.ok(kuaishouFileName('x'.repeat(200), 'ccc').length < 80)
})

test('passesCrawlFilter honours minLike / minView / maxAgeDays', () => {
  const row = { likeCount: 410, viewCount: 85132, timestampMs: 1791652700711 }
  assert.equal(passesCrawlFilter(row), true)
  assert.equal(passesCrawlFilter(row, { minLike: 500 }), false)
  assert.equal(passesCrawlFilter(row, { minLike: 400 }), true)
  assert.equal(passesCrawlFilter(row, { minView: 90000 }), false)
  assert.equal(passesCrawlFilter(row, { maxAgeDays: 30, now: 1791652700711 + 29 * 86400000 }), true)
  assert.equal(passesCrawlFilter(row, { maxAgeDays: 30, now: 1791652700711 + 31 * 86400000 }), false)
  // 没有发布时间的数据，在设了时间筛选时算不合格
  assert.equal(passesCrawlFilter({ likeCount: 1, viewCount: 1 }, { maxAgeDays: 7 }), false)

  assert.deepEqual(normalizeCrawlFilters({ minLike: '', minView: 'abc', maxAgeDays: '7' }), { minLike: 0, minView: 0, maxAgeDays: 7 })
  assert.deepEqual(normalizeCrawlFilters({ minLike: '-3' }), { minLike: 0, minView: 0, maxAgeDays: 0 })
})

test('crawl index remembers hits but misses when the file is gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-crawl-'))
  try {
    const file = join(dir, 'keep.mp4')
    writeFileSync(file, 'bytes')
    const indexPath = join(dir, 'index.jsonl')
    writeFileSync(indexPath, [
      JSON.stringify({ platform: 'kuaishou', id: 'aaa', file, bytes: 5 }),
      'not json at all',
      JSON.stringify({ platform: 'kuaishou', id: 'bbb', file: join(dir, 'gone.mp4'), bytes: 5 }),
    ].join('\n'))

    const index = loadCrawlIndex(indexPath)
    assert.equal(index.size, 2)
    assert.equal(indexHit(index, 'kuaishou', 'aaa').file, file)
    assert.equal(indexHit(index, 'kuaishou', 'bbb'), null)
    assert.equal(indexHit(index, 'kuaishou', 'nope'), null)
    assert.equal(loadCrawlIndex(join(dir, 'missing.jsonl')).size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('summarizeTimings reports page/item averages, slowest and throughput', () => {
  const empty = summarizeTimings()
  assert.equal(empty.searchMs, 0)
  assert.equal(empty.pages.count, 0)
  assert.equal(empty.items.avgMs, 0)
  assert.deepEqual(empty.items.slowest, [])

  const s = summarizeTimings({
    searchMs: 9000,
    downloadMs: 30000,
    pages: [{ ms: 2000 }, { ms: 4000 }],
    items: [
      { id: 'a', ms: 1000, bytes: 1000, ok: true },
      { id: 'b', ms: 3000, bytes: 9000, ok: true },
      { id: 'c', ms: 500, bytes: 0, ok: false },
      { id: 'd', ms: 2000, bytes: 4000, ok: true },
    ],
  })
  assert.equal(s.searchMs, 9000)
  assert.equal(s.downloadMs, 30000)
  assert.equal(s.pages.count, 2)
  assert.equal(s.pages.avgMs, 3000)
  assert.equal(s.pages.maxMs, 4000)
  assert.equal(s.items.count, 4)
  assert.equal(s.items.ok, 3)
  assert.equal(s.items.failed, 1)
  // 平均值只算成功的（失败那条的 500ms 不能拉低平均）
  assert.equal(s.items.avgMs, 2000)
  assert.equal(s.items.maxMs, 3000)
  assert.deepEqual(s.items.slowest.map((x) => x.id), ['b', 'd', 'a'])
  // 14000 字节 / 6000ms
  assert.equal(s.items.bytesPerSec, 2333)
})

test('pickDownloadTask waits for the search phase instead of quitting early', () => {
  // 搜索还没结束、暂时没货：等，不要收工
  assert.deepEqual(pickDownloadTask({ cursor: 0, foundLength: 0, limit: 10, searchDone: false }), { action: 'wait' })
  // 有货就取当前这条
  assert.deepEqual(pickDownloadTask({ cursor: 2, foundLength: 5, limit: 10, searchDone: false }), { action: 'take', index: 2 })
  // 已到 limit：即使搜索还在跑也算下够
  assert.deepEqual(pickDownloadTask({ cursor: 10, foundLength: 30, limit: 10, searchDone: false }), { action: 'stop' })
  // 搜索结束且已消费完：收工
  assert.deepEqual(pickDownloadTask({ cursor: 3, foundLength: 3, limit: 10, searchDone: true }), { action: 'stop' })
  // 搜索结束但一条都没搜到
  assert.deepEqual(pickDownloadTask({ cursor: 0, foundLength: 0, limit: 10, searchDone: true }), { action: 'stop' })
  // limit=0 表示「额度由调用方另算」，这里只负责按 found 取/等/停
  assert.deepEqual(pickDownloadTask({ cursor: 5, foundLength: 30, limit: 0, searchDone: false }), { action: 'take', index: 5 })
  assert.deepEqual(pickDownloadTask({ cursor: 30, foundLength: 30, limit: 0, searchDone: false }), { action: 'wait' })
  assert.deepEqual(pickDownloadTask({ cursor: 30, foundLength: 30, limit: 0, searchDone: true }), { action: 'stop' })
})

test('download watchdog treats stalls and truncation as retryable, 4xx as not', () => {
  assert.equal(DOWNLOAD_STALL_MS, 15000)
  // 卡住不动、响应被截断、5xx、连接断：值得重连
  assert.equal(isRetryableDownloadError('15 秒没有任何数据，断开重连'), true)
  assert.equal(isRetryableDownloadError('只下到 15130/78490665 字节，响应被截断'), true)
  assert.equal(isRetryableDownloadError('单条超过 300 秒，放弃'), true)
  assert.equal(isRetryableDownloadError('HTTP 503 Service Unavailable'), true)
  assert.equal(isRetryableDownloadError('fetch failed'), true)
  // 客户端错误重连也没用
  assert.equal(isRetryableDownloadError('HTTP 403 Forbidden'), false)
  assert.equal(isRetryableDownloadError('HTTP 404 Not Found'), false)
  assert.equal(isRetryableDownloadError(''), false)
})

test('detectCrawlPlatform recognizes bilibili/kuaishou/douyin', () => {
  assert.equal(detectCrawlPlatform('https://www.bilibili.com/video/BV17h4y1r7JT'), 'bilibili')
  assert.equal(detectCrawlPlatform('https://space.bilibili.com/3494363638270349/video'), 'bilibili')
  assert.equal(detectCrawlPlatform('BV17h4y1r7JT'), 'bilibili')
  assert.equal(detectCrawlPlatform('https://b23.tv/abc123'), 'bilibili')
  assert.equal(detectCrawlPlatform('https://www.kuaishou.com/short-video/3xuabp7j6t8mevu'), 'kuaishou')
  assert.equal(detectCrawlPlatform('https://v.kuaishou.com/abc'), 'kuaishou')
  assert.equal(detectCrawlPlatform('https://www.douyin.com/user/MS4wLjABAAAAabcd1234'), 'douyin')
  assert.equal(detectCrawlPlatform('https://www.douyin.com/video/7412'), 'douyin')
  assert.equal(detectCrawlPlatform('MS4wLjABAAAAabcd1234'), 'douyin')
  // 裸关键词不该被猜成任何平台
  assert.equal(detectCrawlPlatform('随便一个关键词'), '')
})

test('platform registry exposes adapters and honors like-filter support', () => {
  const registry = createPlatformRegistry({})
  assert.deepEqual(registry.ids, ['kuaishou', 'bilibili', 'douyin'])
  const bili = registry.get('bilibili')
  assert.equal(bili.label, 'B站')
  assert.equal(bili.needsBrowser, false)
  // 作者主页接口不返回点赞 ⇒ 作者入口不能参与最低点赞筛选，否则整批被筛空
  assert.equal(bili.supportsLikeFilter('creator'), false)
  assert.equal(bili.supportsLikeFilter('keyword'), true)
  assert.equal(registry.get('unknown'), null)
  const douyin = registry.get('douyin')
  assert.equal(douyin.label, '抖音')
  // 抖音必须走浏览器（安全字段由页面运行时补）
  assert.equal(douyin.needsBrowser, true)
  assert.equal(douyin.supportsLikeFilter('creator'), true)
  assert.equal(douyin.resolveCreatorId('https://www.douyin.com/user/MS4wLjABAAAAxyz').creatorId, 'MS4wLjABAAAAxyz')
  // 纯 HTTP 平台没有浏览器会话
  assert.equal(typeof bili.openSession, 'function')
  assert.equal(bili.resolveCreatorId('https://space.bilibili.com/3494363638270349/video').creatorId, '3494363638270349')
  assert.equal(bili.resolveCreatorId('3494363638270349').creatorId, '3494363638270349')
  assert.equal(bili.resolveCreatorId('https://www.bilibili.com/video/BV17h4y1r7JT'), null)
})

test('bilibili wbi signing and row mapping keep the fields crawl needs', () => {
  const { signedQuery } = wbiSign('ea1db124af3c7062474693fa704f4ff8', { keyword: '大枣', page: 1 }, 1700000000)
  assert.match(signedQuery, /^keyword=%E5%A4%A7%E6%9E%A3&page=1&wts=1700000000&w_rid=[0-9a-f]{32}$/)
  // 值里的 !'()* 直接剔除（不是百分号编码），空格变 +，~ 编码成 %7E
  const tricky = wbiSign('k', { q: "a!b'c(d)e*f g~h" }, 1).signedQuery
  assert.match(tricky, /^q=abcdef\+g%7Eh&wts=1&w_rid=[0-9a-f]{32}$/)
  assert.ok(BILI_DM_PARAMS.dm_img_list)

  assert.equal(cleanBiliTitle('<em class="keyword">大枣</em> 怎么吃'), '大枣 怎么吃')
  const row = biliRow({ bvid: 'BV17h4y1r7JT', title: 'x', author: 'a', mid: 42, play: 12000, like: 7, pubdate: 1691243215, duration: '09:52' }, { keyword: '大枣' })
  assert.equal(row.id, 'BV17h4y1r7JT')
  assert.equal(row.mid, '42')
  assert.equal(row.viewCount, 12000)
  assert.equal(row.timestampMs, 1691243215000)
  assert.equal(row.durationMs, 592000)
  // 作者主页返回的作品没有 like 字段：保持 undefined，不要补 0（否则会被最低点赞筛掉）
  assert.equal(biliRow({ bvid: 'BV1Ko4izNEvn', title: 't', created: 1760514994, length: '01:26' }, { source: 'creator' }).likeCount, undefined)
})

test('douyin decode handles chunked frames and plain json', () => {
  const payload = { status_code: 0, has_more: true, cursor: 20, data: [{ aweme_id: '7412', desc: '大枣', video: { play_addr: { url_list: ['https://cdn/1.mp4'] }, duration: 15000 } }] }
  const chunk = Buffer.from(JSON.stringify(payload), 'utf8')
  const framed = Buffer.concat([
    Buffer.from(chunk.length.toString(16) + '\r\n', 'latin1'),
    chunk,
    Buffer.from('\r\n0\r\n\r\n', 'latin1'),
  ]).toString('utf8')
  const decoded = decodeDouyinPayloads(framed)
  assert.equal(decoded.length, 1)
  assert.equal(decoded[0].status_code, 0)
  assert.equal(decodeDouyinPayloads(JSON.stringify(payload)).length, 1)
  assert.deepEqual(decodeDouyinPayloads(''), [])
  // 半截帧不能崩，也不能凭空造出对象
  assert.deepEqual(decodeDouyinPayloads('ff\r\n{"a":1}'), [])
})

test('douyin verdict separates login, captcha, rate limit and reject', () => {
  assert.equal(douyinVerdict({ status_code: 0 }).kind, 'ok')
  assert.equal(douyinVerdict({ status_code: 2483, status_msg: '请先登录，再继续搜索吧' }).kind, 'need_login')
  assert.equal(douyinVerdict({ status_code: 8 }).kind, 'need_login')
  assert.equal(douyinVerdict({ status_code: 2154, status_msg: '请求过于频繁' }).kind, 'rate_limited')
  assert.equal(douyinVerdict({ status_code: 1000, status_msg: 'captcha verify' }).kind, 'captcha')
  assert.equal(douyinVerdict({ status_code: 0, search_nil_info: { search_nil_type: 'verify_check' } }).kind, 'captcha')
  assert.equal(douyinVerdict({ status_code: 12345, status_msg: 'boom' }).kind, 'blocked')
  assert.equal(douyinVerdict(null).kind, 'failed')
})

test('douyin row keeps missing stats undefined and picks the direct play url', () => {
  const row = douyinRow({
    aweme_id: '7412345678901234567',
    desc: '新疆大枣 #好吃',
    create_time: 1760514994,
    statistics: { digg_count: 1234, play_count: 5678 },
    video: { duration: 15000, play_addr: { url_list: ['https://v3/cdn/1.mp4', 'https://v3/cdn/backup.mp4'] } },
    author: { nickname: '枣农', sec_uid: 'MS4wLjABAAAAxz' },
  })
  assert.equal(row.id, '7412345678901234567')
  assert.equal(row.likeCount, 1234)
  assert.equal(row.viewCount, 5678)
  assert.equal(row.timestampMs, 1760514994000)
  assert.equal(row.durationMs, 15000)
  assert.equal(row.source.url, 'https://v3/cdn/1.mp4')
  assert.deepEqual(row.source.backupUrl, ['https://v3/cdn/backup.mp4'])
  assert.equal(row.author, '枣农')
  // 没有 digg_count 时保持 undefined，绝不补 0
  const bare = douyinRow({ aweme_id: '2', video: { play_addr: { url_list: [] } } })
  assert.equal(bare.likeCount, undefined)
  assert.equal(bare.source.url, '')
  assert.equal(douyinRow({ desc: 'no id' }), null)

  // play_addr 里混进音乐/封面时不能当视频下（实测踩过：存出来的不是视频）
  const mixed = douyinRow({
    aweme_id: '3',
    statistics: { digg_count: 10, play_count: 0 },
    video: {
      play_addr: {
        url_list: [
          'https://sf26-sign.douyinstatic.com/tos-cn-ve-2774/obj/cover.jpeg',
          'https://lf26-music-east.douyinstatic.com/obj/ies-music/abc.mp3',
          'https://v26-web.douyinvod.com/abc/video/tos/cn/tos-cn-ve-2774/xyz/?a=1',
        ],
      },
    },
  })
  assert.equal(mixed.source.url, 'https://v26-web.douyinvod.com/abc/video/tos/cn/tos-cn-ve-2774/xyz/?a=1')
  assert.equal(mixed.source.kind, 'direct')
  // play_count 恒 0 的搜索结果：当作「未知」而不是「没人看」
  assert.equal(mixed.viewCount, undefined)

  // 只剩静态资源 → 标 images/missing，canDownload 会拦掉
  const imagesOnly = douyinRow({
    aweme_id: '4',
    images: [{ url_list: ['https://p3/cdn/a.jpeg'] }],
    video: { play_addr: { url_list: ['https://sf26-sign.douyinstatic.com/obj/cover.jpeg'] } },
  })
  assert.equal(imagesOnly.source.url, '')
  assert.equal(imagesOnly.source.kind, 'images')
  const missingOnly = douyinRow({
    aweme_id: '5',
    video: { play_addr: { url_list: ['https://sf26-sign.douyinstatic.com/obj/cover.jpeg'] } },
  })
  assert.equal(missingOnly.source.kind, 'missing')
  assert.equal(createDouyinAdapter().canDownload(missingOnly), false)
})

test('douyin helpers: file name, page cursor, creator id', () => {
  assert.equal(douyinFileName('新疆大枣 #好吃', '7412'), '新疆大枣 好吃 [7412].mp4')
  assert.equal(douyinFileName('', '7412'), 'douyin [7412].mp4')
  const st = douyinPageState({ has_more: true, cursor: 20, extra: { logid: 'abc' } })
  assert.deepEqual(st, { hasMore: true, next: 20, searchId: 'abc' })
  assert.equal(douyinPageState(null).hasMore, false)
  assert.equal(douyinResolveCreatorId('https://www.douyin.com/user/MS4wLjABAAAAq').creatorId, 'MS4wLjABAAAAq')
  assert.equal(douyinResolveCreatorId('MS4wLjABAAAAq').creatorId, 'MS4wLjABAAAAq')
  assert.equal(douyinResolveCreatorId('https://www.douyin.com/video/7412'), null)
})

test('douyin extractor walks nested containers without inventing items', () => {
  const found = douyinExtractAwemes({ data: [{ aweme_info: { aweme_id: '1', video: {} } }, { card: { aweme_id: '2', images: [] } }] })
  assert.deepEqual(found.map((x) => x.aweme_id), ['1', '2'])
  assert.deepEqual(douyinExtractAwemes({ data: [{ author: { nickname: 'x' } }] }), [])
})
test('refererFor picks the right anti-hotlink referer per CDN host', () => {
  // 曾经写死成快手，抖音直链一律 403
  assert.equal(refererFor('https://v26-web.douyinvod.com/x/video/tos/a.mp4'), 'https://www.douyin.com/')
  assert.equal(refererFor('https://upos-sz-mirror08c.bilivideo.com/a.m4s'), 'https://www.bilibili.com/')
  assert.equal(refererFor('https://alimov2.a.kwimgs.com/a.mp4'), 'https://www.kuaishou.com/')
  assert.equal(refererFor('https://v1.kwaicdn.com/a.mp4'), 'https://www.kuaishou.com/')
  assert.equal(refererFor('https://example.com/a.mp4'), '')
  assert.equal(refererFor('not a url'), '')
})

test('signWebQuery matches the reference implementation byte for byte', () => {
  // 参考值由 CreatorHub 的 web_request.sign_web_query 在同一输入下算出（Python 侧实测）
  const r = signWebQuery('a=1&uifid=old&timestamp=999&b=%E5%A4%A7', 'DEV123', { timestamp: 1700000000 })
  assert.equal(
    r.query,
    'a=1&uifid=DEV123&b=%E5%A4%A7&timestamp=1700000000&x-secsdk-web-signature=af6244ffcb6702aefca75a53427f6408',
  )
  assert.equal(r.signature, 'af6244ffcb6702aefca75a53427f6408')
  assert.deepEqual(r.headers, {
    uifid: 'DEV123',
    'x-secsdk-web-signature': 'af6244ffcb6702aefca75a53427f6408',
    'x-secsdk-web-expire': '1700000000',
  })
  // 没有 uifid 时自动补一个；重复的 uifid 只保留第一个
  const noDev = signWebQuery('a=1&uifid=x&uifid=y', 'DEV', { timestamp: 1 })
  assert.match(noDev.query, /uifid=DEV/)
  assert.equal((noDev.query.match(/uifid=/g) || []).length, 1)
  assert.throws(() => signWebQuery('a=1', '', { timestamp: 1 }), /invalid_device_id/)
})

test('websign path rules: search unsigned, post needs both signatures', () => {
  assert.equal(needsWebSignature('/aweme/v1/web/aweme/post/'), true)
  assert.equal(needsWebSignature('/aweme/v1/web/aweme/post'), true)
  assert.equal(needsWebSignature('/aweme/v1/web/user/profile/self/'), false)
  assert.equal(isSearchPath('/aweme/v1/web/general/search/stream/'), true)
  assert.equal(isSearchPath('/aweme/v1/web/general/search/stream'), true)
  assert.equal(isSearchPath('/aweme/v1/web/aweme/post/'), false)
  assert.equal(uifidFromCookie('a=1; UIFID=dev42; b=2'), 'dev42')
  assert.equal(uifidFromCookie('uifid_lower=dev43'), '')
  assert.equal(uifidFromCookie('uifid=lower43'), 'lower43')
  assert.equal(uifidFromCookie(''), '')
})

test('buildRequest signs per path and never signs search', () => {
  const cookie = 'UIFID=dev123; sessionid=abc'
  const search = buildRequest('/aweme/v1/web/general/search/stream/', { keyword: '枣' }, { cookie })
  assert.equal(search.signed, 'none')
  assert.doesNotMatch(search.url, /a_bogus=/)
  assert.match(search.url, /uifid=dev123/)
  assert.equal(search.headers.uifid, undefined)

  const post = buildRequest('/aweme/v1/web/aweme/post/', { sec_user_id: 'x' }, { cookie })
  assert.equal(post.signed, 'abogus+web')
  assert.match(post.url, /a_bogus=/)
  assert.match(post.url, /x-secsdk-web-signature=/)
  assert.equal(post.headers.uifid, 'dev123')
  assert.ok(post.headers['x-secsdk-web-expire'])

  const self = buildRequest('/aweme/v1/web/user/profile/self/', {}, { cookie })
  assert.equal(self.signed, 'abogus')
  assert.match(self.url, /a_bogus=/)
  assert.match(self.url, /msToken=/)
  assert.equal(self.headers.uifid, undefined)
})

test('cookieStringOf accepts Map, array and raw string', () => {
  assert.equal(cookieStringOf(new Map([['a', '1'], ['b', '2']])), 'a=1; b=2')
  assert.equal(cookieStringOf([{ name: 'a', value: '1' }, { name: '', value: 'x' }]), 'a=1')
  assert.equal(cookieStringOf('a=1; b=2'), 'a=1; b=2')
  assert.equal(cookieStringOf(null), '')
  assert.equal(fakeMsToken().length, 126)
  assert.match(fingerprintOf(), /^1536\|864\|1560\|944\|/)
})

