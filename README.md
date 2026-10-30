# dsh-video-downloader

DeepSeek Harness（DSH）0.2.x 的视频下载插件：识别视频链接、把 B 站页面链接解析成真实流、把视频与音频下载到本地并自动合并。

面向 **DSH 0.2.1-rc.2** 重写，核心变化是「页面链接可直接下载」——不再要求你先手工拿到直链。

## 功能

| 工具 | 作用 |
| --- | --- |
| `video_analyze` | 判断链接类型：`page`（可解析的页面）/ `direct`（直链媒体）/ `unknown`，给出站点、扩展名、MIME 提示 |
| `video_resolve` | 把 B 站 BV 号、`bilibili.com/video/...`、`b23.tv` 短链解析成可下载的流清单（画质、编码、体积） |
| `video_download` | 下载直链，或直接下载 B 站页面链接（自动选流、下音视频、ffmpeg 合并为 mp4） |
| `video_quality_parse` | 从 URL 参数推断画质与容器格式，纯本地计算 |

## 使用示例

```
video_analyze   { "url": "https://www.bilibili.com/video/BV1GJ411x7h7" }
video_resolve   { "url": "BV1GJ411x7h7" }
video_download  { "url": "https://www.bilibili.com/video/BV1GJ411x7h7" }
video_download  { "url": "https://example.com/clip.mp4", "outPath": "D:\\media\\clip.mp4" }
```

`video_download` 返回 JSON：`savedTo`（落盘路径）、`bytes`、`muxed`（是否经过 ffmpeg 合并）、`quality`、`title`、`durationSec`；失败时返回 `{ "error": "...", "message": "..." }`，不会把异常抛到会话里。

## 下载位置

优先级：

1. 工具参数 `outPath`
2. 环境变量 `DSH_VIDEO_DOWNLOAD_DIR`
3. 默认 `~/Downloads/dsh-video-downloader/`

文件名取自视频标题 + BV 号，已过滤 Windows 非法字符并限长。

## ffmpeg

B 站 DASH 流的视频与音频是分离的，需要 ffmpeg 合并。查找顺序：

1. 环境变量 `DSH_FFMPEG_PATH`
2. `PATH` 上的 `ffmpeg`

找不到 ffmpeg 时不会静默失败，`video_download` 返回 `error: "ffmpeg_missing"` 并说明原因；只有单条流的站点不需要 ffmpeg。

## 支持范围

- **B 站**：BV 号、标准页面链接、`b23.tv` 短链、多 P（`?p=`）。匿名访问最高 480P；登录 cookie 才能拿到 1080P 及以上（当前版本不带账号态）。
- **直链媒体**：mp4 / m4s / webm / mkv / flv / ts / m3u8 / mpd 等按扩展名与 Content-Type 判定。
- **其他站点**（YouTube / 抖音 / 小红书等）：只做链接分类与直链下载，不做平台签名解析——这些站点需要各自的签名算法与账号态，不在本插件范围内。

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
- 依赖：只用 `@deepseek-ai/dsh-tools` 的 `defineTool` 与 `ctx.tools.register`，从宿主解析，不额外安装内核副本

## 测试

```bash
node --test test/index.test.js
```

覆盖链接分类、BV/cid 提取、轨道挑选、文件名清洗、四个工具的注册与错误分支。

## 许可证

MIT
