/**
 * 抖音 Web 端 `a_bogus` 查询签名（纯 JS，无第三方依赖）。
 *
 * 算法按 CreatorHub 的 app/platforms/douyin/signing/abogus.py（1.0.1.19 线格式）逐段移植：
 * 两套自定义 base64 字母表 + SM3 双层摘要 + RC4 混淆 UA + 固定变换盒（_TRANSFORM_BOX）重排，
 * 最后把 44 个有序字段、指纹串与校验字节一起送进 transform。
 *
 * ⚠️ 这套东西随抖音前端版本变化。改版后表现为「接口一律回 status_code 8 / 空数据」，
 * 处理办法是重新对照浏览器 Network 里的 a_bogus 长度与字段序，而不是加参数乱试。
 */
import { sm3ToArray } from './sm3.js'

const ALPHABETS = [
  'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe',
  'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe',
]
const OPTIONS = [0, 1, 14]
const SALT = 'cus'
const SORT_INDEX = [
  18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35,
  57, 39, 41, 43, 22, 28, 32, 60, 36, 23, 29, 33, 37, 44, 45, 59, 46,
  47, 48, 49, 50, 24, 25, 65, 66, 70, 71,
]
const XOR_INDEX = [
  18, 20, 26, 30, 34, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28,
  32, 36, 23, 29, 33, 37, 44, 45, 46, 47, 48, 49, 50, 24, 25, 52, 53,
  54, 55, 57, 58, 59, 60, 65, 66, 70, 71,
]
const TRANSFORM_BOX = [
  121, 243, 55, 234, 103, 36, 47, 228, 30, 231, 106, 6, 115, 95, 78,
  101, 250, 207, 198, 50, 139, 227, 220, 105, 97, 143, 34, 28, 194,
  215, 18, 100, 159, 160, 43, 8, 169, 217, 180, 120, 247, 45, 90, 11,
  27, 197, 46, 3, 84, 72, 5, 68, 62, 56, 221, 75, 144, 79, 73, 161,
  178, 81, 64, 187, 134, 117, 186, 118, 16, 241, 130, 71, 89, 147,
  122, 129, 65, 40, 88, 150, 110, 219, 199, 255, 181, 254, 48, 4, 195,
  248, 208, 32, 116, 167, 69, 201, 17, 124, 125, 104, 96, 83, 80, 127,
  236, 108, 154, 126, 204, 15, 20, 135, 112, 158, 13, 1, 188, 164,
  210, 237, 222, 98, 212, 77, 253, 42, 170, 202, 26, 22, 29, 182, 251,
  10, 173, 152, 58, 138, 54, 141, 185, 33, 157, 31, 252, 132, 233,
  235, 102, 196, 191, 223, 240, 148, 39, 123, 92, 82, 128, 109, 57,
  24, 38, 113, 209, 245, 2, 119, 153, 229, 189, 214, 230, 174, 232,
  63, 52, 205, 86, 140, 66, 175, 111, 171, 246, 133, 238, 193, 99,
  60, 74, 91, 225, 51, 76, 37, 145, 211, 166, 151, 213, 206, 0, 200,
  244, 176, 218, 44, 184, 172, 49, 216, 93, 168, 53, 21, 183, 41, 67,
  85, 224, 155, 226, 242, 87, 177, 146, 70, 190, 12, 162, 19, 137,
  114, 25, 165, 163, 192, 23, 59, 9, 94, 179, 107, 35, 7, 142, 131,
  239, 203, 149, 136, 61, 249, 14, 156,
]

export const DEFAULT_FP =
  '1536|747|1560|827|0|0|0|0|1536|864|1536|864|1536|747|24|24|Win32'

/** 抖音/字节那套自定义 base64：3 字节一组、大端 24 位、末尾不足补 '='。 */
export function customBase64(data, alphabet) {
  const raw = Buffer.from(Array.from(data, (x) => x & 0xff))
  const out = []
  for (let offset = 0; offset < raw.length; offset += 3) {
    const chunk = raw.subarray(offset, offset + 3)
    const padded = Buffer.alloc(3)
    chunk.copy(padded)
    const value = (padded[0] << 16) | (padded[1] << 8) | padded[2]
    out.push(alphabet[(value >> 18) & 63])
    out.push(alphabet[(value >> 12) & 63])
    out.push(chunk.length > 1 ? alphabet[(value >> 6) & 63] : '=')
    out.push(chunk.length > 2 ? alphabet[value & 63] : '=')
  }
  return out.join('')
}

/** RC4：签名里只用来把 UA 混成一段字节。 */
export function rc4(key, data) {
  const k = Array.from(key, (x) => x & 0xff)
  const s = new Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + k[i % k.length]) & 0xff
    const t = s[i]; s[i] = s[j]; s[j] = t
  }
  const out = []
  let i2 = 0
  j = 0
  for (const byte of data) {
    i2 = (i2 + 1) & 0xff
    j = (j + s[i2]) & 0xff
    const t = s[i2]; s[i2] = s[j]; s[j] = t
    out.push((byte & 0xff) ^ s[(s[i2] + s[j]) & 0xff])
  }
  return out
}

const doubleDigest = (value) => sm3ToArray(sm3ToArray(String(value) + SALT))

function uaDigest(userAgent) {
  const encrypted = rc4(OPTIONS, Buffer.from(String(userAgent), 'utf8'))
  return sm3ToArray(customBase64(encrypted, ALPHABETS[1]))
}

/** 3 组、每组 4 字节的伪随机；与原实现同样只用到 0-9999 的范围。 */
function randomBytes(groups = 3) {
  const out = []
  for (let i = 0; i < groups; i++) {
    const value = Math.floor(Math.random() * 10000)
    out.push(
      ((value & 0xff) & 0xaa) | 1,
      ((value & 0xff) & 0x55) | 2,
      ((value >> 8) & 0xaa) | 5,
      ((value >> 8) & 0x55) | 40,
    )
  }
  return out
}

function transform(values) {
  const box = TRANSFORM_BOX.slice()
  let indexB = box[1]
  let initial = 0
  let valueE = 0
  const out = []
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    let mixedIndex
    if (index === 0) {
      initial = box[indexB]
      mixedIndex = indexB + initial
      box[1] = initial
      box[indexB] = indexB
    } else {
      mixedIndex = initial + valueE
    }
    mixedIndex %= box.length
    out.push((value & 0xff) ^ box[mixedIndex])

    const slot = (index + 2) % box.length
    valueE = box[slot]
    mixedIndex = (indexB + valueE) % box.length
    initial = box[mixedIndex]
    const tmp = box[slot]
    box[mixedIndex] = tmp
    box[slot] = initial
    indexB = mixedIndex
  }
  return out
}

/**
 * 生成 a_bogus 值。
 * @param {string} params 已 urlencode 的查询串（不含 `?`、不含 a_bogus）
 * @param {string} userAgent 与请求头一致的 UA（UA 参与摘要，换了就签不出来）
 * @param {{body?: string, fp?: string}} [opts]
 */
export function aBogus(params, userAgent, opts = {}) {
  const fp = opts.fp || DEFAULT_FP
  const body = opts.body || ''
  const started = Date.now()
  const paramsHash = doubleDigest(params)
  const bodyHash = doubleDigest(body)
  const uaHash = uaDigest(userAgent || 'Mozilla/5.0')
  const finished = Date.now()

  const fields = {
    8: 3,
    18: 44,
    19: [1, 0, 1, 0, 1],
    66: 0,
    69: 0,
    70: 0,
    71: 0,
    20: (started >>> 24) & 0xff,
    21: (started >>> 16) & 0xff,
    22: (started >>> 8) & 0xff,
    23: started & 0xff,
    // 毫秒时间戳超过 32 位，`>>> 32` 在 JS 里会退化成 `>>> 0`，必须用除法取高位
    24: Math.floor(started / 0x100000000) & 0xff,
    25: Math.floor(started / 0x10000000000) & 0xff,
    26: (OPTIONS[0] >>> 24) & 0xff,
    27: (OPTIONS[0] >>> 16) & 0xff,
    28: (OPTIONS[0] >>> 8) & 0xff,
    29: OPTIONS[0] & 0xff,
    30: (OPTIONS[1] >>> 8) & 0xff,
    31: OPTIONS[1] & 0xff,
    32: (OPTIONS[1] >>> 24) & 0xff,
    33: (OPTIONS[1] >>> 16) & 0xff,
    34: (OPTIONS[2] >>> 24) & 0xff,
    35: (OPTIONS[2] >>> 16) & 0xff,
    36: (OPTIONS[2] >>> 8) & 0xff,
    37: OPTIONS[2] & 0xff,
    38: paramsHash[21],
    39: paramsHash[22],
    40: bodyHash[21],
    41: bodyHash[22],
    42: uaHash[23],
    43: uaHash[24],
    44: (finished >>> 24) & 0xff,
    45: (finished >>> 16) & 0xff,
    46: (finished >>> 8) & 0xff,
    47: finished & 0xff,
    49: Math.floor(finished / 0x100000000) & 0xff,
    50: Math.floor(finished / 0x10000000000) & 0xff,
    51: 0,
    52: 0,
    53: 0,
    54: 0,
    55: 0,
    56: 6383,
    57: 6383 & 0xff,
    58: (6383 >>> 8) & 0xff,
    59: (6383 >>> 16) & 0xff,
    60: (6383 >>> 24) & 0xff,
    64: fp.length,
    65: fp.length,
  }
  fields[48] = fields[8]

  const ordered = SORT_INDEX.map((i) => (fields[i] === undefined ? 0 : fields[i]))
  let checksum = fields[XOR_INDEX[0]]
  for (const i of XOR_INDEX.slice(1)) checksum ^= fields[i] === undefined ? 0 : fields[i]
  const payload = ordered.concat(Array.from(Buffer.from(fp, 'ascii')), [checksum & 0xff])
  return customBase64(randomBytes(3).concat(transform(payload)), ALPHABETS[0])
}

/** 与 python 的 urlencode（quote_via=quote_plus）+ quote(safe='') 对齐的转义。 */
export function quoteStrict(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** 在查询串后面接上 a_bogus（已转义），返回可直接拼进 URL 的串。 */
export function signQuery(queryString, userAgent, opts = {}) {
  const signature = aBogus(queryString, userAgent, opts)
  const sep = queryString ? '&' : ''
  return `${queryString}${sep}a_bogus=${quoteStrict(signature)}`
}
