# dsh-video-downloader

DeepSeek Harness（DSH）0.2.x 的视频下载插件：丢一个视频页面链接就能下载，不需要先拿到直链。

面向 **DSH 0.2.1-rc.2** 重写，三条链路：B 站走内置解析（不依赖外部程序），抖音走本机无头浏览器取播放流（不需要 Cookie），其他站点交给本机通用后端 yt-dlp。

## 功能

| 工具 | 作用 |
| --- | --- |
| `video_analyze` | 判断链接类型与由哪个后端处理：`bilibili` / `ytdlp` / `direct` / `unsupported`，给出站点、扩展名、MIME 提示。纯本地计算 |
| `video_resolve` | 把页面链接解析成流清单，不下载：B 站走内置解析，抖音走本地浏览器通路，其他站点走 yt-dlp |
| `video_download` | 下载：直链直接下；B 站页面链接内置解析 + ffmpeg 合并；抖音用本地浏览器取播放流直下；其他站点页面链接交给 yt-dlp |
| `video_quality_parse` | 从 URL 参数推断画质与容器格式，纯本地计算 |

## 使用示例

```
video_analyze   { "url": "https://www.bilibili.com/video/BV1GJ411x7h7" }
video_resolve   { "url": "BV1GJ411x7h7" }
video_download  { "url": "https://www.bilibili.com/video/BV1GJ411x7h7" }
video_download  { "url": "https://www.douyin.com/video/xxxx", "quality": "best" }
video_download  { "url": "https://www.xiaohongshu.com/explore/xxxx", "cookies": "D:\\cookies.txt" }
video_download  { "url": "https://example.com/clip.mp4", "outPath": "D:\\media\\clip.mp4" }
```

`video_download` 返回 JSON：`savedTo`（落盘路径）、`bytes`、`backend`（`bilibili` / `ytdlp` / `direct`）、`quality`、`title`、`elapsedMs`；失败返回 `{ "error": "...", "message": "..." }`，不会把异常抛到会话里。

`error` 取值：`unsupported`（插件不处理这类链接）、`need_login`（要登录态，给 `cookies` 再试）、`blocked`（风控/403/429，含抖音的 Argus 拦截）、`unavailable`（视频已删除或地区限制）、`not_found`（404）、`network`、`missing_ffmpeg`、`backend_missing`（没装 yt-dlp 或找不到浏览器）、`no_stream`（播放页没给出可下载地址）。

## 下载位置

优先级：

1. 工具参数 `outPath`
2. 环境变量 `DSH_VIDEO_DOWNLOAD_DIR`
3. 默认 `~/Downloads/dsh-video-downloader/`

`outPath` 传**目录**（已存在的目录，或以 `/`、`\` 结尾）时，按视频标题自动命名并**直接写进该目录**，不再先落默认目录再搬；传文件名时按该名保存（扩展名自动补 `.mp4`）。

文件名取自视频标题（B 站额外带 BV 号），已过滤 Windows 非法字符并限长。

## 外部依赖

### yt-dlp

B 站以外站点靠它解析与下载，站点适配、签名、登录态都由它维护，插件只负责调用与归因。

1. 环境变量 `DSH_YTDLP_PATH`
2. `PATH` 上的 `yt-dlp` / `yt-dlp.exe`

没装时只有 B 站与直链可用，其他站点返回 `error: "backend_missing"`。

需要代理才能访问的站点（如 YouTube），设置 `DSH_YTDLP_PROXY=http://127.0.0.1:7897`。

需要登录态的内容，把浏览器导出的 `cookies.txt` 路径传给 `cookies` 参数；插件不接触账号密码。

### ffmpeg

B 站 DASH 流的视频与音频是分离的，需要 ffmpeg 合并。查找顺序：

1. 环境变量 `DSH_FFMPEG_PATH`
2. `PATH` 上的 `ffmpeg`

找不到时不会静默失败：音视频分别落盘，返回值里 `muxed: false` 并给出合并命令；只有单条流的站点不需要 ffmpeg。

## 抖音通路

抖音的详情接口要 UIFID 与签名，yt-dlp 无 Cookie 时直接 403。插件改走**本机无头浏览器**：

1. 链接先归一：个人页 `?modal_id=<id>`、分享文本、`/video/<id>` 都折成 `https://www.douyin.com/video/<id>`；
2. 起一个 Edge/Chrome 的 `--headless=new` 实例，用 CDP 打开播放页，读 `<video>` 的 `currentSrc`（并用资源计时表交叉验证）；
3. 页面偶尔先给出几秒钟的试看流，因此对所有候选地址各发一次 1 字节请求比体积，取最大的那条；
4. 带宽走 `Referer: https://www.douyin.com/` 直接下载，**不经过系统代理**（代理会让抖音接口 403）。
5. `v.douyin.com/<码>` 这类**分享短链先走一次普通 HTTP 跳转**（两次 302，约 0.3–0.5 秒，不开浏览器）解出 19 位 id，再让浏览器打开标准的 `/video/<id>` 页面——短链失效与取流失败因此能分辨开。

浏览器查找顺序：`DSH_BROWSER_PATH` → 常见 Edge/Chrome 安装路径。找不到时退回 yt-dlp，两条路都失败才报错（`error: "no_stream"` 表示页面没给出播放地址，通常要登录或作品已失效）。

抖音这条路上 yt-dlp 基本必被 403 且会卡上分钟，因此**只在找不到浏览器时才回退 yt-dlp**，浏览器通路出错直接返回它自己的错误码。

### 速度

浏览器实例**常驻复用**（进程内共享，空闲 3 分钟自动退出，profile 留在系统临时目录当缓存）。取流只等「页面给出播放地址」这一件事，分辨率不再阻塞下载：

- 首次调用（含起浏览器）：约 2–3 秒；
- 同一进程内后续调用：约 1.5–2 秒；
- 落盘后再用本机 ffmpeg 读一次真实宽高，`quality` 报的是文件本身的短边（例如 576P / 1080P）。

试看流防护按「页面标题是否已出 + 体积是否过 800 KB」判断，宁可多等几百毫秒，也不会把几秒钟的片段当成成品。

## 支持范围

- **B 站**：BV 号、标准页面链接、`b23.tv` 短链、多 P（`?p=`）。走内置解析；能读到 B 站登录凭证时清晰度上限等于账号权限（大会员可到 1080P+ / 4K / 8K），读不到就退回匿名（最高 480P）。凭证文件按 `DSH_BILI_CREDENTIAL` → `%APPDATA%\dsh-desktop\harness\bili-duty\bili_credential.json` → `$DSH_HOME` / `~/.dsh` 下的 `bili_credential.json` 顺序找，支持 `sessdata` / `bili_jct` / `buvid3` / `dedeuserid` 字段（值可以是 URL 编码）；凭证过期或文件损坏自动退回匿名，不会把请求弄挂。
- **抖音**：`/video/<id>`、个人页 `?modal_id=<id>`、`v.douyin.com/<码>` 短链、整段分享文本（含短链）、裸的 19 位 id 都认；走本地浏览器通路，默认不需要 Cookie、不需要登录，公开作品即可下。直播、会员、私密作品不处理。
- **直链媒体**：mp4 / m4s / webm / mkv / flv / ts 按扩展名与 Content-Type 判定，原生下载；m3u8 / mpd 是播放列表不是媒体本身，交给 yt-dlp 拉流合并，不再当成视频文件直接存盘。
- **其他站点**：交给 yt-dlp，覆盖其支持的全部站点（小红书、YouTube、快手、Vimeo 等）。能不能下取决于站点与登录态：小红书多需 cookies，YouTube 需代理，会员内容仍受账号权限限制。
- **不做**：DRM 内容、付费墙绕过。

## 安装

### 本地目录（开发/自用）

在 DSH profile 的 `package.json` 里加依赖与 bundle：

```json
{
  "dependencies": {
    "dsh-video-downloader": "link:D:\\500 工作\\源码\\dsh-video-downloader-master"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-video-downloader"]
    }
  }
}
```

重启 DSH 后生效。

### 从 GitHub

```bash
pnpm add github:fromzero1501/dsh-video-downloader-v2
```

## 兼容性

- DSH：`>=0.2.0-rc.2 <0.3.0`（`engines.dsh`，启动时由 `dsh-app-boot` 校验）
- Node：`>=20`
- 依赖：运行时不 import 任何内核包（`ctx.tools.register()` 只需要普通 JSON Schema），参数 DSL 由插件自己编译，因此不会装出第二份 `dsh-tools`

## 测试

```bash
node --test test/index.test.js
```

覆盖链接分类与后端路由、BV/cid 提取、轨道挑选、文件名清洗、yt-dlp 错误归因、抖音链接归一与播放列表分流、四个工具的注册与错误分支。

## 许可证

MIT
