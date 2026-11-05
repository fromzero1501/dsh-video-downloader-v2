/**
 * hostdeps.js — 从宿主那棵树里取 `@deepseek-ai/schemastery`（设置页的 `Config` 要用它）。
 *
 * 为什么要绕：
 *   profile 是 `autoInstallPeers: false`，`@deepseek-ai/schemastery` 是 optional peer，
 *   本插件自己的 dependencies 里没有它 ⇒ 裸 import 在桌面版必然失败 ⇒ **整条插件不激活**。
 *
 * 策略：
 *   ① 先按可能的宿主位置解析（跟宿主用同一份，行为一致）；
 *   ② 解析不到就裸 import 兜底（自己装了依赖的机器上也能跑）；
 *   ③ 彻底拿不到返回 null —— 插件**照常加载**，只是没有 `Config`、设置页降级。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const PKG = 'schemastery'
const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  const appData = (process.env.APPDATA || '').trim()
  if (appData) {
    const npm = join(appData, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  const dshHome = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  try {
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }
  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch {
    return null
  }
}

/** schemastery 的模块命名空间；拿不到返回 null（调用方必须容忍 null）。 */
export async function loadSchemastery() {
  for (const root of candidateRoots()) {
    const url = entryUrlFor(root, PKG)
    if (!url) continue
    try {
      const mod = await import(url)
      return mod?.default ?? mod ?? null
    } catch {
      // 换下一个候选位置
    }
  }
  try {
    const mod = await import(`@deepseek-ai/${PKG}`)
    return mod?.default ?? mod ?? null
  } catch {
    return null
  }
}
