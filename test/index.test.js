import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  analyze,
  classifyYtDlpError,
  detectSite,
  extractBvid,
  extractPage,
  getExt,
  getQuality,
  isMedia,
  isResolvablePage,
  pickAudioTrack,
  pickVideoTrack,
  routeFor,
  sanitizeName,
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
