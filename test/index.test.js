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

test('apply registers the four tools with valid JSON-Schema parameters', () => {
  const ctx = mockCtx()
  apply(ctx)
  const names = ctx.all.map((t) => t.name).sort()
  assert.deepEqual(names, ['video_analyze', 'video_download', 'video_quality_parse', 'video_resolve'])
  for (const t of ctx.all) {
    assert.equal(typeof t.description, 'string')
    assert.equal(t.parameters.type, 'object')
    assert.deepEqual(t.parameters.required, ['url'])
    assert.equal(t.parameters.properties.url.type, 'string')
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
