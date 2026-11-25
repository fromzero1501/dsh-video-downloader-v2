# dsh-video-downloader

DeepSeek Harness（DSH）0.2.x 的视频下载插件：丢一个视频页面链接就能下载，不需要先拿到直链。

面向 **DSH 0.2.1-rc.2** 重写，四条链路：B 站走内置解析（不依赖外部程序），抖音走本机无头浏览器取播放流（不需要 Cookie），其他站点交给本机通用后端（yt-dlp 优先、lux 兜底），批量爬取另有平台适配器（快手走本地浏览器拿签名 → 搜索接口翻页 → CDN 直链下载；B站走纯 HTTP + wbi 签名）。

## 功能

| 工具 | 作用 |
| --- | --- |
| `video_analyze` | 判断链接类型与由哪个后端处理：`bilibili` / `ytdlp`（通用后端）/ `direct` / `unsupported`，给出站点、扩展名、MIME 提示，以及通用后端当前的候选顺序与就绪情况。纯本地计算 |
| `video_resolve` | 把页面链接解析成流清单，不下载：B 站走内置解析，抖音走本地浏览器通路，其他站点走通用后端（yt-dlp → lux） |
| `video_download` | 下载：直链直接下；B 站页面链接内置解析 + ffmpeg 合并；抖音用本地浏览器取播放流直下；其他站点页面链接交给通用后端（yt-dlp → lux） |
| `video_quality_parse` | 从 URL 参数推断画质与容器格式，纯本地计算 |
| `video_crawl` | 批量爬取（异步任务，立刻返回 `jobId`）：`keyword` 按关键词、`creator` 按作者主页，`platform` 不给就按链接自动判断（快手 / B站）。落盘 `<根>\<平台>\<关键词或作者名>\`，下载前按「最近 N 天发布 / 最低点赞 / 最低播放量」筛选，索引去重，重复跑是增量 |
| `video_crawl_status` | 查爬取进度：`phase`（当前关键词 + 第几页）、`stats`（搜到/筛掉/已下/跳过/失败/字节）、`items`、`timings`（搜索/下载墙钟、页均、单条均、吞吐、最慢三条）、`needHuman`（暂停原因 + 二维码截图路径） |
| `video_crawl_resume` | 人工处理完验证码 / 扫码后，从索引里已下载的条目之后继续跑 |
| `video_crawl_cancel` | 取消任务（已下载的文件保留） |

## 使用示例

```
video_analyze   { "url": "https://www.bilibili.com/video/BV1GJ411x7h7" }
video_resolve   { "url": "BV1GJ411x7h7" }
video_download  { "url": "https://www.bilibili.com/video/BV1GJ411x7h7" }
video_download  { "url": "https://www.douyin.com/video/xxxx", "quality": "best" }
video_download  { "url": "https://www.xiaohongshu.com/explore/xxxx", "cookies": "D:\\cookies.txt" }
video_download  { "url": "https://example.com/clip.mp4", "outPath": "D:\\media\\clip.mp4" }
video_crawl     { "keyword": "和田大枣", "limit": 50, "minLike": 100, "minView": 5000, "maxAgeDays": 30 }
video_crawl     { "creator": "https://space.bilibili.com/3494363638270349/video", "limit": 30 }
video_crawl_status { "jobId": "kuaishou-20261125-172248-b549" }
```

`video_crawl` 只管把视频抓到盘上，不做关键词扩展——`synonyms` 里传什么就按顺序补搜什么：先把主关键词翻页到底，条数不够再依次用同义词补。

`video_download` 返回 JSON：`savedTo`（落盘路径）、`bytes`、`backend`（`bilibili` / `ytdlp` / `lux` / `douyin-browser` / `direct`）、`quality`、`title`、`elapsedMs`；失败返回 `{ "error": "...", "message": "..." }`，不会把异常抛到会话里。

换过通用后端时（例如 yt-dlp 说 `unsupported` 之后 lux 接手），返回里另带 `attempts: [{ backend, error, message }]`，能看出是谁失败、为什么换。

`error` 取值：`unsupported`（插件不处理这类链接）、`need_login`（要登录态，给 `cookies` 再试）、`blocked`（风控/403/429，含抖音的 Argus 拦截）、`unavailable`（视频已删除或地区限制）、`not_found`（404）、`network`、`missing_ffmpeg`、`backend_missing`（没装 yt-dlp / lux，或找不到浏览器）、`no_stream`（播放页没给出可下载地址）。

## 下载位置

优先级：

1. 工具参数 `outPath`
2. 没给 `outPath` → `<爬取根>\<平台中文名>\`（**按平台分目录**，与关键词爬取同一套口径）

爬取根默认 `D:\500 工作\视频爬取`，设置页可改，或用 `DSH_CRAWL_ROOT`；平台目录名走别名表（`kuaishou`→快手 / `bilibili`→B站 / `youtube`→YouTube / `douyin`→抖音 / `xiaohongshu`→小红书 / 其他→其他）。

`outPath` 传**目录**（已存在的目录，或以 `/`、`\` 结尾）时，按视频标题自动命名并**直接写进该目录**；传文件名时按该名保存（扩展名自动补 `.mp4`）；传相对路径时以「默认下载目录」（`DSH_VIDEO_DOWNLOAD_DIR` → `~/Downloads/dsh-video-downloader/`）为基准。

文件名取自视频标题（B 站额外带 BV 号，快手带视频 id），已过滤 Windows 非法字符并限长。

## 外部依赖

### yt-dlp

通用后端的**主力**：B 站以外站点优先靠它解析与下载，站点适配、签名、登录态都由它维护，插件只负责调用与归因。

1. 环境变量 `DSH_YTDLP_PATH`
2. `PATH` 上的 `yt-dlp` / `yt-dlp.exe`

没装时只有 B 站与直链可用，其他站点返回 `error: "backend_missing"`。

需要代理才能访问的站点（如 YouTube），设置 `DSH_YTDLP_PROXY=http://127.0.0.1:7897`。

需要登录态的内容，把浏览器导出的 `cookies.txt` 路径传给 `cookies` 参数；插件不接触账号密码。

### lux

第二通用后端，**只兜底**：补 yt-dlp 没有的那几个国内站（快手、腾讯视频、好看视频、秒拍、Threads、StreamTape…）。它的站点表停在 2024 年，官方接口一改就会失效，所以默认顺序是 yt-dlp 先、lux 后。

安装（需要 Go）：

```bash
GOPROXY=https://goproxy.cn,direct go install github.com/iawia002/lux@latest
```

查找顺序：

1. 设置页「lux 路径」或环境变量 `DSH_LUX_PATH`
2. `PATH` 上的 `lux` / `lux.exe`
3. `GOBIN`、`~/go/bin`（`go install` 的默认落点）

`lux -v` 会打印 `version v0.0.0` —— 这是 `go install` 没注入版本变量导致的，功能不受影响。

几条已知差异：

- **代理只认环境变量**：lux 没有 `--proxy` 参数，插件把「yt-dlp 代理」或 `DSH_LUX_PROXY` 写进子进程的 `HTTP_PROXY` / `HTTPS_PROXY`。
- **`-f` 是站内自定义流 id**（如 `32-12`），和 yt-dlp 的 `formatId` 不能互用，靠返回里的 `backend` 区分。
- **抖音永远不用 lux**：lux 关不掉代理，而抖音直链走系统代理会被风控；抖音只有浏览器通路与 yt-dlp 两条路。
- 清晰度偏好按分辨率换算：`112`/`80`→1080P、`64`→720P、`32`→480P、`16`→360P；站点没这一档就降到最接近且可达的那一档。
- lux 合并分离的音视频轨时直接 `exec ffmpeg`，只认 `PATH`，所以插件会把探测到的 ffmpeg 目录写进子进程 `PATH`（找不到 ffmpeg 时 lux 自己会以 `missing_ffmpeg` 报错）。

### ffmpeg

B 站 DASH 流的视频与音频是分离的，需要 ffmpeg 合并。查找顺序：

1. 环境变量 `DSH_FFMPEG_PATH`
2. `PATH` 上的 `ffmpeg`

找不到时不会静默失败：音视频分别落盘，返回值里 `muxed: false` 并给出合并命令；只有单条流的站点不需要 ffmpeg。

## 批量爬取（快手 / B站）

两个入口，两种落点：

| 入口 | 调用 | 落盘 |
| --- | --- | --- |
| 关键词 | `video_crawl { "keyword": "和田大枣", "limit": 50 }` | `<爬取根>\<平台>\<关键词>\` |
| 作者主页 | `video_crawl { "creator": "https://space.bilibili.com/3494363638270349/video", "limit": 30 }` | `<爬取根>\<平台>\<作者名>\` |

`keyword` 与 `creator` 二选一；`platform` 不给时按链接/关键词自动判断（`bilibili.com`/`BV` 号 → bilibili，`kuaishou.com`/`kwai.com` → kuaishou）。抖音的批量通道还没实现，`detectCrawlPlatform` 故意不返回 douyin。

平台差异全部落在 `src/platforms/<平台>.js` 的适配器里（`searchKeyword` / `listCreator` / `download` / `supportsLikeFilter` / `maxConcurrency`），`crawl.js` 只负责调度、筛选、去重、并发、续传、计时——加新平台不用动调度层。

### 快手

`video_crawl { "keyword": "和田大枣", "limit": 50 }` → 后台任务，落盘 `<爬取根>\快手\和田大枣\`。

**怎么拿数据**：快手网页端的搜索接口要一个叫 `__NS_hxfalcon` 的签名，签名必须由页面自己的 JS 现算（绑定请求体 + 时间窗口），所以插件起一个**有头 Edge + 持久 profile**，用 `Page.addScriptToEvaluateOnNewDocument` 在页面脚本之前劫持 `Object.prototype.caver` 的 setter，抓住同时带 `$encode` 与 `$getCatVersion` 的那个对象，再在页面里 `call('$encode', ...)` 生成签名，然后**在页面内** `fetch('/rest/v/search/feed?__NS_hxfalcon=<sign>&caver=2')`。每页 20 条，`pcursor` 递增翻页。

**为什么不用 yt-dlp / lux**：两者都只能吃单链接，不认关键词；而且快手的 `photo.manifest.adaptationSet[].representation[].url` 多数是现成的单文件 mp4 直链（免 Cookie 免签名，Node 侧 Range 请求实测 206），下载这条链路不需要合并分片。

**HLS 回落**：少数作品的所有变体都只给 `.m3u8` 播放列表，直接按 URL 落盘会存下一段 `#EXTM3U` 文本。所以挑流时**优先非 HLS 变体**；只剩 HLS 时才下载播放列表、把里面的相对分片地址补成绝对地址、交给 ffmpeg `-c copy` 合并成 mp4（不转码）。没装 ffmpeg 时该条记 `failed` 并在 `error` 里说明，不影响同批其他条。

**登录态**：首次跑会自动打开浏览器，`needHuman.qrPath` 给出二维码截图路径，你在手机上扫码确认后任务自动继续（最多等 3 分钟）。cookie 存在 `<DSH_HOME>\video-downloader\kuaishou\profile\`（Edge 的持久 profile），后续任务直接复用，不用重复扫码。

**下载前筛选**：`maxAgeDays` / `minLike` / `minView` 三个条件在**搜索阶段**就过滤，不达标的直接丢，不下载、不占磁盘。快手没有单独的点赞——「喜欢」就是点赞，`likeCount` 取不到时按 `realLikeCount` / `likedCount` / `like` 依次回退。

**去重与增量**：唯一键是「平台 + 视频 id」，命中索引且文件还在盘才跳过，所以同一个关键词重复跑是增量，不会重复下载。索引在 `<DSH_HOME>\video-downloader\index.jsonl`，任务状态在 `...\crawl\<jobId>.json`。

**限速与并发**：搜索串行、页间隔默认 1.5 秒 + 0–1.5 秒抖动（`DSH_KS_PAGE_DELAY_MS` 可调）；下载并发默认 6（`concurrency` 可调，夹在 1–8）。限流（`result:2`）退避重试，连续 3 次就停下。

**遇到验证码 / 风控**：立刻**暂停任务**（`status: paused_need_human`），把当时的页面截图存到 `<DSH_HOME>\video-downloader\kuaishou\pause-<jobId>.png`，在 `needHuman` 里带上是登录失效、验证码还是被拦。你人工处理完用 `video_crawl_resume` 续跑，从已下载的条目之后继续。

**各环节用时**：任务的 `timings` 字段记录搜索阶段与下载阶段的墙钟耗时，并给出页均/单条均/最慢三条/下载吞吐（`bytesPerSec`）。下载是并发跑的，所以所有单条耗时加起来会大于下载墙钟，别拿两者相减。`video_crawl_status` 直接回 `timings` 的汇总值，用来判断该调页间隔还是该调并发。

**搜索与下载并行**：搜到 4 条就开始下载，搜索继续往下翻、结果随时塞进待下队列。所以总时长趋近 `max(搜索, 下载)` 而不是两者相加，`timings` 里 `searchMs` 与 `downloadMs` 会重叠（`overlapMs` 就是这么来的），相加大于总耗时为正常。

**为什么并发是 6**：同一批独立 URL 实测——并发 2 → 6.2 MB/s，4 → 19.8，6 → 36.7，8 → 30.7（回落到带宽/CDN 上限）。默认取 6。注意同一批 URL 短时间内重复下载会被 CDN 限速，测速必须换新链接，否则只能测到 1 MB/s 左右。

**为什么不做 Range 分段**：同 10 条对比单流与 4 段并行，单条均提速 2.09 倍，但**总时长反而长 69%**——分段多出来的握手开销压过并行收益，而且把长尾切得更碎。小文件单流本来就能跑到数十 MB/s，没必要分段。

**长尾怎么处理**：单条不按体积估超时（会误杀「慢但在推进」的连接，实测 78 MB 走 75 秒也能正常下完），改成「连续 15 秒没有字节就中断重连」＋单条 300 秒总预算，下完再拿 `content-length` 校验是否被截断；可重试的失败（截断、5xx、连接重置）会重连，上限 `max(3, 并发数)` 次，4xx 直接判失败。

**索引命中不占额度**：重复跑同一个关键词时，索引里已经下过的会跳过，且**不占用 `limit` 计数**——否则第二次跑一个词只会补到一两条就宣布「够了」。

**已知限制**：安全 cookie（`kwscode` / `kwssectoken`）大约 6 分钟轮换一次，所以登录态是靠持久 profile 里的浏览器会话维持的，不是靠抓一段 cookie 复制走；快手改签名算法就得跟着改（劫持点只有一个，改起来集中）。任务只在 DSH 进程活着时跑，进程重启后未完成的任务要手动 `video_crawl_resume`。另外单条速率取决于快手 CDN 的缓存状态，冷门作品可能只有 0.5–1.5 MB/s，小样本测出来的聚合速率不能当常态，只有几十条以上才看得出并发收益。

### B站

**纯 HTTP，不开浏览器**：`wbi` 签名在 Node 侧自己算——`GET /x/web-interface/nav` 拿 `wbi_img`（未登录会回 `-101`，但 `wbi_img` 照给），把 `img_url` / `sub_url` 的文件名段按官方 64 项重排表拼出 `mixin_key`，请求参数加秒级 `wts`、剔除 `!"()*`、按 key 排序、WHATWG 编码后取 `w_rid = md5(query + mixin_key)`。`mixin_key` 缓存 1 小时，签名失效（`-403`）时自动重取一次。

| 入口 | 接口 | 分页 | 点赞 |
| --- | --- | --- | --- |
| 关键词 | `/x/web-interface/wbi/search/type`（`search_type=video`、`page_size=20`、`order=totalrank`） | 页码 `page`，`data.numPages` 封顶 | 有（`like`） |
| 作者主页 | `/x/space/wbi/arc/search`（`ps=30`、`order=pubdate`） | 页码 `pn`，`data.page.count` 封顶 | **没有** |

- 作者主页接口对匿名请求查得很严，**必须三样齐全**：`buvid3`/`buvid4` cookie（`/x/frontend/finger/spi` 现取，缓存 12 小时）、四个 `dm_*` 设备指纹参数、`space.bilibili.com` 的 referer。缺任一项直接 `412 request was banned`（四种组合的对照见 `probe-bili-space.mjs`，这个结论是实测出来的，不是猜的）。
- 作者主页也不返回点赞，所以**作者入口不参与「最低点赞」筛选**（`supportsLikeFilter('creator') === false`）；你填了 `minLike` 也会被自动清零并在 `filterNotes` 里说明，否则整批会被筛空。缺失的字段保持 `undefined`，绝不补 0。
- 请求自带 1.1–1.7 秒间隔排队（`BILI_MIN_GAP_MS`），下载并发上限 2——B站是按请求频率风控的，连打几次就 `-352 风控校验失败`，排队比事后重试划算。冷却期内任务会退避 8/16/32 秒后转 `paused_need_human`，等几分钟再 `video_crawl_resume` 即可。
- 搜索结果的标题带 `<em class="keyword">…</em>` 高亮标签，落盘前会清掉；`duration` 是 `mm:ss` / `hh:mm:ss` 文本，转成毫秒。
- 下载复用插件已有的 B站单链下载（DASH 选流 + ffmpeg 合并），所以 B站批量**需要 ffmpeg**。

### 各平台对照

| | 快手 | B站 |
| --- | --- | --- |
| 搜索通道 | 有头 Edge + 页面内现签名 | 纯 HTTP + wbi 签名 |
| 登录 | 必须（首次扫码，持久 profile） | 不需要 |
| 作者主页 | `/rest/v/profile/feed` | `/x/space/wbi/arc/search` |
| 点赞筛选 | 有效 | 仅关键词入口有效 |
| 下载 | 单文件 mp4 直链（HLS 才借 ffmpeg） | DASH 分离，需 ffmpeg |
| 并发上限 | 6 | 2 |


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

## 设置页

**设置 → 左侧栏「视频下载」**（与「刷B站」同级的那一页）。改完点保存即生效，不用重启；留空 = 没设（退回下一层），所以清空设置页不会让插件失效。

页面顶部是只读状态：B站 是否读到登录凭证、ffmpeg / yt-dlp / lux 是否就绪、当前实际落盘目录、找到的凭证文件路径。

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| 默认下载目录 | 空 | 空 = 系统 `Downloads\dsh-video-downloader`；保存时会自动创建该目录 |
| 默认清晰度偏好 | `best` | `best` / `worst` / `112`(1080P高码率) / `80`(1080P) / `64`(720P) / `32`(480P) / `16`(360P)；没有权限的档位自动降到可达的最高档，回报的是实际档位 |
| 读取本机 B 站登录凭证 | 开 | 关掉 = 纯匿名，最高只到 480P |
| B 站凭证文件路径 | 空 | 空 = 按 `DSH_BILI_CREDENTIAL` → `%APPDATA%\dsh-desktop\harness\bili-duty` → `$DSH_HOME` / `~/.dsh` 顺序自动查找 |
| ffmpeg 路径 | 空 | 空 = 自动探测；填错会退回自动探测（页面会红字提示），不会让下载直接失败 |
| yt-dlp 路径 | 空 | 同上 |
| lux 路径 | 空 | 空 = 自动探测（`DSH_LUX_PATH` → `PATH` → `GOBIN` → `~/go/bin`）；只在 yt-dlp 干不了时被调用 |
| 通用后端顺序 | `auto` | `auto` = yt-dlp 优先、lux 兜底（推荐）/ `ytdlp` = 只用 yt-dlp / `lux` = lux 优先、yt-dlp 兜底。抖音固定不用 lux |
| yt-dlp 代理 | 空 | 只作用于非 B 站站点（yt-dlp 与 lux 共用）；B 站 一律直连（抖音也强制直连）。关键词爬取也直连，不走这个代理 |
| 爬取根目录 | 空 | 空 = `D:\500 工作\视频爬取`；单链接下载（未给 `outPath` 时）与关键词爬取都落在这下面，保存时自动创建 |
| 批量爬取默认平台 | `kuaishou` | 只影响没显式传 `platform` 时的默认值；传了链接或 `platform` 参数以调用为准 |
| 最近 N 天 | 空 | 空或 0 = 不限；只下载发布时间在最近 N 天内的（没有发布时间的数据在设了这个条件时算不合格） |
| 最低点赞 | 空 | 空或 0 = 不限；快手的「喜欢」就是点赞 |
| 最低播放量 | 空 | 空或 0 = 不限 |

优先级：**单次工具调用的显式传参 > 设置页 > 环境变量 > 内置默认**。环境变量（`DSH_VIDEO_DOWNLOAD_DIR` / `DSH_BILI_CREDENTIAL` / `DSH_FFMPEG_PATH` / `DSH_YTDLP_PATH` / `DSH_YTDLP_PROXY` / `DSH_LUX_PATH` / `DSH_LUX_PROXY` / `DSH_GENERIC_BACKEND` / `DSH_CRAWL_ROOT` / `DSH_KS_PAGE_DELAY_MS`）仍可用，但设置页里填了就以设置页为准。

这一页的存盘位置是 `$DSH_HOME/video-downloader/config.json`（只存你改过的键，删掉某个键就等于回到「没设」）。DSH 自带的「内置插件」里那份同一组字段的表单仍保留，两个入口写的是同一套值，谁后设谁生效。

设置面板只存**路径指针**，不存凭证内容：SESSDATA 等敏感值依旧只躺在你自己的凭证文件里，面板不读也不回显。

## 支持范围

- **B 站**：BV 号、标准页面链接、`b23.tv` 短链、多 P（`?p=`）。走内置解析；能读到 B 站登录凭证时清晰度上限等于账号权限（大会员可到 1080P+ / 4K / 8K），读不到就退回匿名（最高 480P）。凭证文件按 `DSH_BILI_CREDENTIAL` → `%APPDATA%\dsh-desktop\harness\bili-duty\bili_credential.json` → `$DSH_HOME` / `~/.dsh` 下的 `bili_credential.json` 顺序找，支持 `sessdata` / `bili_jct` / `buvid3` / `dedeuserid` 字段（值可以是 URL 编码）；凭证过期或文件损坏自动退回匿名，不会把请求弄挂。
- **抖音**：`/video/<id>`、个人页 `?modal_id=<id>`、`v.douyin.com/<码>` 短链、整段分享文本（含短链）、裸的 19 位 id 都认；走本地浏览器通路，默认不需要 Cookie、不需要登录，公开作品即可下。直播、会员、私密作品不处理。
- **直链媒体**：mp4 / m4s / webm / mkv / flv / ts 按扩展名与 Content-Type 判定，原生下载；m3u8 / mpd 是播放列表不是媒体本身，交给 yt-dlp 拉流合并，不再当成视频文件直接存盘。
- **其他站点**：交给通用后端——yt-dlp 优先、lux 兜底，覆盖两者支持的站点（小红书、YouTube、Vimeo、快手、腾讯视频、好看视频等）。lux 的增量价值就是那几个 yt-dlp 没有的国内站；两边都有时仍由 yt-dlp 出手（适配与维护更好）。能不能下取决于站点与登录态：小红书多需 cookies，YouTube 需代理，会员内容仍受账号权限限制。
- **快手（关键词爬取）**：按关键词批量抓，落 `<根>\快手\<关键词>\`。走本地浏览器拿签名 + 网页搜索接口翻页 + CDN 直链下载，不需要 yt-dlp / lux；只有极少数只给 HLS 播放列表的作品才借 ffmpeg 合并。首次要扫码登录一次，cookie 由持久 profile 维持；直播、私密作品、需要付费的内容不处理。遇到验证码会被拦下等你人工处理，不会硬闯。
- **B站（关键词 + 作者主页爬取）**：纯 HTTP + wbi 签名，不需要浏览器、不需要登录。关键词落 `<根>\B站\<关键词>\`，作者主页落 `<根>\B站\<作者名>\`；下载复用单链通路的 DASH 选流 + ffmpeg 合并。作者主页接口不返回点赞，该入口自动忽略「最低点赞」条件。风控（`-352`）按频率触发，冷却几分钟后 `video_crawl_resume` 续跑。
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
node --test
```

覆盖链接分类与后端路由、BV/cid 提取、轨道挑选、文件名清洗、yt-dlp / lux 错误归因、抖音链接归一与播放列表分流、通用后端候选序列（含抖音排除 lux）、lux JSON 容错与流挑选、lux 落盘文件定位、子进程环境变量大小写、快手搜索返回码归因、快手流挑选与字段归一（含 HLS 优先降级）、快手法文件名、爬取筛选（时间/点赞/播放量）、爬取索引去重、HLS 播放列表地址补全、各环节耗时汇总（`summarizeTimings`）、流水线取任务与下载看门狗判定、平台自动识别（抖音故意不认）、平台注册表与点赞筛选能力声明、B站 wbi 签名与行字段映射（作者入口不伪造点赞），以及八个工具的注册与错误分支。当前 49 个用例。

## 许可证

MIT
