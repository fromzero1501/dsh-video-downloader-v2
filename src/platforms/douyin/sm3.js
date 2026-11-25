/**
 * 纯 JS 的 SM3（GB/T 32905），只给抖音 `a_bogus` 签名内部用。
 *
 * 移植自 CreatorHub 的 app/platforms/douyin/signing/sm3.py（同一套 IV / P0 / P1 / Tj / FF / GG），
 * 但按 JS 的位运算语义重写：每一步都 >>> 0 收成无符号 32 位，避免 Python 的任意精度整数
 * 与 JS 的 int32 溢出行为不一致。
 */

const IV = [
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
  0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
]

function rotl(x, n) {
  const s = n & 31
  if (s === 0) return x >>> 0
  return ((x << s) | (x >>> (32 - s))) >>> 0
}

const p0 = (x) => (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0
const p1 = (x) => (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0
const tOf = (j) => (j < 16 ? 0x79cc4519 : 0x7a879d8a)
const ff = (x, y, z, j) => (j < 16 ? (x ^ y ^ z) >>> 0 : ((x & y) | (x & z) | (y & z)) >>> 0)
const gg = (x, y, z, j) => (j < 16 ? (x ^ y ^ z) >>> 0 : ((x & y) | (~x & z)) >>> 0)

function compress(v, block, offset) {
  const w = new Array(68)
  for (let i = 0; i < 16; i++) {
    const p = offset + i * 4
    w[i] = ((block[p] << 24) | (block[p + 1] << 16) | (block[p + 2] << 8) | block[p + 3]) >>> 0
  }
  for (let j = 16; j < 68; j++) {
    w[j] = (p1(w[j - 16] ^ w[j - 9] ^ rotl(w[j - 3], 15)) ^ rotl(w[j - 13], 7) ^ w[j - 6]) >>> 0
  }
  const w1 = new Array(64)
  for (let j = 0; j < 64; j++) w1[j] = (w[j] ^ w[j + 4]) >>> 0

  let [a, b, c, d, e, f, g, h] = v
  for (let j = 0; j < 64; j++) {
    const ss1 = rotl((rotl(a, 12) + e + rotl(tOf(j), j)) >>> 0, 7)
    const ss2 = (ss1 ^ rotl(a, 12)) >>> 0
    const tt1 = (ff(a, b, c, j) + d + ss2 + w1[j]) >>> 0
    const tt2 = (gg(e, f, g, j) + h + ss1 + w[j]) >>> 0
    d = c
    c = rotl(b, 9)
    b = a
    a = tt1
    h = g
    g = rotl(f, 19)
    f = e
    e = p0(tt2)
  }
  return [
    (a ^ v[0]) >>> 0, (b ^ v[1]) >>> 0, (c ^ v[2]) >>> 0, (d ^ v[3]) >>> 0,
    (e ^ v[4]) >>> 0, (f ^ v[5]) >>> 0, (g ^ v[6]) >>> 0, (h ^ v[7]) >>> 0,
  ]
}

/** 对字节数组做 SM3，返回 32 个 0-255 的字节值。 */
export function sm3Bytes(input) {
  const src = input instanceof Uint8Array ? input : Uint8Array.from(input, (b) => b & 0xff)
  const bitLen = src.length * 8
  // 补位：0x80 + 0x00… 直到 (len % 64) === 56，再补 8 字节大端长度
  const padded = new Uint8Array(Math.ceil((src.length + 9) / 64) * 64)
  padded.set(src)
  padded[src.length] = 0x80
  const hi = Math.floor(bitLen / 0x100000000)
  const lo = bitLen >>> 0
  const end = padded.length
  padded[end - 8] = (hi >>> 24) & 0xff
  padded[end - 7] = (hi >>> 16) & 0xff
  padded[end - 6] = (hi >>> 8) & 0xff
  padded[end - 5] = hi & 0xff
  padded[end - 4] = (lo >>> 24) & 0xff
  padded[end - 3] = (lo >>> 16) & 0xff
  padded[end - 2] = (lo >>> 8) & 0xff
  padded[end - 1] = lo & 0xff

  let v = IV.slice()
  for (let i = 0; i < padded.length; i += 64) v = compress(v, padded, i)

  const out = new Array(32)
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (v[i] >>> 24) & 0xff
    out[i * 4 + 1] = (v[i] >>> 16) & 0xff
    out[i * 4 + 2] = (v[i] >>> 8) & 0xff
    out[i * 4 + 3] = v[i] & 0xff
  }
  return out
}

/** 接受 string / 字节数组，统一返回 32 个字节值（对应 CreatorHub 的 sm3_to_array）。 */
export function sm3ToArray(data) {
  if (typeof data === 'string') return sm3Bytes(Buffer.from(data, 'utf8'))
  return sm3Bytes(Uint8Array.from(data, (b) => b & 0xff))
}
