/**
 * dsh-video-downloader —— 浏览器半端（「设置」左侧栏独立一页：视频下载）
 * ============================================================================
 * ⚠️ client bundle **不是 ESM**，是自注册脚本（DSH 的约定）：
 *     window.__ModuleLoader__.load({ id: '<等于 package.json 的 name>', factory: (require) => ({ inject, apply }) })
 * 进「设置」的办法是往 `settings.section` slot 注册一项（label = 左侧导航那一行），
 * 不要自己糊标题栏按钮 + 全屏遮罩（第一版那样做，一眼就跟别的插件不一样）。
 *
 * 这一页只做两件事：
 *   ① 读 `/api/video-downloader/state` —— 当前生效值 + 只读状态（登录态 / ffmpeg / yt-dlp / lux / 落地目录）
 *   ② 写 `/api/video-downloader/config` —— 保存改动，写完回读核对；失败必须红字，不许绿字骗人
 *
 * 版式：顶部一条状态带 + 若干可折叠分区。分区头右侧直接显示该项的「现在其实是什么」，
 * 想改再展开——这样默认状态下一屏就能看完所有当前生效值。
 */
window.__ModuleLoader__.load({
  id: 'dsh-video-downloader',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/video-downloader'

    /** 只认 2xx：HTTP 500 的 { ok:false } 绝不能被当成"已保存"。 */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）'
      : res.status === 403 ? '（被宿主拦了）'
      : res.status === 404 ? '（后端接口没挂上：重启 DSH 桌面端后重试，或看插件日志）'
      : ''
      let detail = ''
      try { const j = await res.json(); if (j && j.error) detail = '：' + j.error } catch { /* 没有 JSON 就算了 */ }
      throw new Error('HTTP ' + res.status + why + detail)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const QUALITY_OPTIONS = [
      ['best', 'best · 跟随账号权限取最高（默认）'],
      ['worst', 'worst · 取最低（省流量）'],
      ['112', '112 · 1080P 高码率'],
      ['80', '80 · 1080P'],
      ['64', '64 · 720P'],
      ['32', '32 · 480P'],
      ['16', '16 · 360P'],
    ]

    // 非 B站 站点的后端顺序：auto 是推荐值（lux 站点维护停滞，不该挡在前面）
    const BACKEND_OPTIONS = [
      ['auto', 'auto · yt-dlp 优先，lux 兜底（推荐）'],
      ['ytdlp', 'yt-dlp · 只用 yt-dlp'],
      ['lux', 'lux · lux 优先，yt-dlp 兜底'],
    ]

    // 批量爬取平台：只有实现了适配器的才在这里出现
    const PLATFORM_OPTIONS = [
      ['kuaishou', '快手'],
      ['bilibili', 'B站'],
      ['douyin', '抖音'],
    ]

    // 三个门槛都是固定档位（下拉），不用记数字；要精确值就在 video_crawl 里传参覆盖。
    const LIKE_OPTIONS = [
      ['', '不限'],
      ['100', '100+'],
      ['500', '500+'],
      ['1000', '1000+'],
      ['5000', '5000+'],
      ['10000', '1 万+'],
      ['50000', '5 万+'],
    ]
    const VIEW_OPTIONS = [
      ['', '不限'],
      ['1000', '1000+'],
      ['5000', '5000+'],
      ['10000', '1 万+'],
      ['50000', '5 万+'],
      ['100000', '10 万+'],
      ['500000', '50 万+'],
    ]
    const AGE_OPTIONS = [
      ['', '不限'],
      ['1', '最近 1 天'],
      ['3', '最近 3 天'],
      ['7', '最近 7 天'],
      ['15', '最近 15 天'],
      ['30', '最近 30 天'],
      ['90', '最近 90 天'],
      ['365', '最近一年'],
      ['1095', '最近 3 年'],
    ]

    // 设置键按平台分开存：crawlMinLikeKuaishou / crawlMinLikeBilibili / crawlMinLikeDouyin
    const PLATFORM_SUFFIX = { kuaishou: 'Kuaishou', bilibili: 'Bilibili', douyin: 'Douyin' }
    const filterKeyOf = (field, platform) => field + (PLATFORM_SUFFIX[platform] || 'Kuaishou')
    // 接口不提供的数据：填了也没用，界面上直接置灰
    const PLATFORM_LIMITS = {
      kuaishou: {},
      bilibili: { minLike: '作者主页接口不返回点赞，走作者入口时这一项会被自动忽略' },
      douyin: { minView: '抖音搜索结果不提供播放量，这一项对抖音无效' },
    }

    const CSS = `
[data-vd-page]{display:flex;flex-direction:column;gap:12px;padding:2px 2px 28px;font-size:14px;line-height:1.55}
[data-vd-top]{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:10px 0 10px;background:var(--bg-primary,canvas);border-bottom:1px solid rgba(127,127,127,.16)}
[data-vd-chip]{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(127,127,127,.28);border-radius:999px;padding:2px 10px 2px 8px;font-size:12px;opacity:.92;white-space:nowrap;max-width:100%}
[data-vd-dot]{width:6px;height:6px;border-radius:50%;background:rgba(127,127,127,.65);flex:0 0 auto}
[data-vd-chip][data-ok] [data-vd-dot]{background:#2ea043}
[data-vd-chip][data-bad] [data-vd-dot]{background:#d05a3c}
[data-vd-chip][data-ok]{border-color:rgba(46,160,67,.42)}
[data-vd-chip][data-bad]{border-color:rgba(210,90,60,.42)}
[data-vd-chip] [data-vd-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.8;overflow:hidden;text-overflow:ellipsis;max-width:42ch;white-space:nowrap}
[data-vd-grow]{flex:1 1 auto}
[data-vd-sec]{border:1px solid rgba(127,127,127,.2);border-radius:12px;overflow:hidden;background:rgba(127,127,127,.028)}
[data-vd-head]{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:10px 14px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
[data-vd-head]:hover{background:rgba(127,127,127,.06)}
[data-vd-caret]{width:12px;flex:0 0 auto;opacity:.5;font-size:10px;transition:transform .12s ease}
[data-vd-title]{font-weight:600;font-size:13.5px;letter-spacing:.01em}
[data-vd-sum]{flex:1 1 auto;min-width:0;font-size:12px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
[data-vd-body]{display:flex;flex-direction:column;gap:14px;padding:2px 14px 14px}
[data-vd-hint]{font-size:12px;opacity:.6}
[data-vd-row]{display:grid;grid-template-columns:minmax(0,1fr) minmax(160px,46%);gap:14px;align-items:start}
[data-vd-col]{display:flex;flex-direction:column;gap:10px}
[data-vd-filters]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
[data-vd-filter]{display:flex;flex-direction:column;gap:4px;min-width:0}
[data-vd-label]{font-weight:500}
[data-vd-note]{font-size:12px;opacity:.58;margin-top:2px}
[data-vd-src]{font-size:11px;opacity:.42;margin-top:2px}
[data-vd-acct]{display:flex;flex-direction:column;gap:8px;margin:2px 0 10px}
[data-vd-acct-row]{display:flex;align-items:center;gap:10px;padding:8px 11px;border:1px solid rgba(127,127,127,.22);border-radius:10px}
[data-vd-acct-row] b{font-weight:600;min-width:44px}
[data-vd-acct-row] [data-vd-badge]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;opacity:.7}
[data-vd-acct-row] [data-vd-badge][data-ok],[data-vd-acct-row] [data-vd-badge][data-done],[data-vd-acct-row] [data-vd-badge][data-on]{opacity:1}
[data-vd-acct-row] [data-vd-btn]{padding:4px 12px;font-size:12.5px}
[data-vd-input]{box-sizing:border-box;width:100%;padding:7px 10px;border:1px solid rgba(127,127,127,.32);border-radius:9px;background:transparent;color:inherit;font-family:inherit;font-size:13px;transition:border-color .12s ease}
[data-vd-input]:hover{border-color:rgba(127,127,127,.5)}
[data-vd-input]:focus{outline:2px solid rgba(80,140,255,.4);outline-offset:0;border-color:rgba(80,140,255,.55)}
[data-vd-btn]{padding:5px 14px;border:1px solid rgba(127,127,127,.35);border-radius:9px;background:transparent;color:inherit;font-family:inherit;font-size:13px;cursor:pointer;transition:border-color .12s ease,background .12s ease}
[data-vd-btn]:hover:not(:disabled){background:rgba(127,127,127,.09)}
[data-vd-btn][data-primary]{border-color:rgba(80,140,255,.6);color:#3b82f6}
[data-vd-btn][data-primary][data-dirty]{background:rgba(80,140,255,.12)}
[data-vd-btn]:disabled{opacity:.45;cursor:default}
[data-vd-msg]{display:flex;gap:8px;align-items:flex-start;border-radius:9px;padding:7px 11px;font-size:12.5px;border:1px solid rgba(127,127,127,.3)}
[data-vd-msg][data-good]{border-color:rgba(46,160,67,.5);color:#2ea043}
[data-vd-msg][data-warn]{border-color:rgba(210,90,60,.5);color:#d05a3c}
[data-vd-switch]{display:inline-flex;align-items:center;gap:8px;padding:5px 12px;border:1px solid rgba(127,127,127,.32);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}
[data-vd-switch][data-on]{border-color:rgba(46,160,67,.55);color:#2ea043}
[data-vd-switch][data-on] [data-vd-dot]{background:#2ea043}
[data-vd-foot]{font-size:12px;opacity:.5;padding:2px 2px 0}
[data-vd-bad]{font-size:12px;opacity:.62;padding:8px 0}
[data-vd-tabs]{display:flex;gap:6px;margin:1px 0 4px}
[data-vd-tab]{padding:5px 14px;border:1px solid rgba(127,127,127,.32);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;transition:border-color .12s ease,background .12s ease}
[data-vd-tab]:hover{background:rgba(127,127,127,.08)}
[data-vd-tab][data-on]{border-color:rgba(80,140,255,.65);color:#3b82f6;background:rgba(80,140,255,.1)}
[data-vd-input]:disabled{opacity:.42;cursor:not-allowed}
[data-vd-flat]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
[data-vd-flat] [data-vd-filter]{gap:4px}
@media (max-width:720px){[data-vd-row]{grid-template-columns:minmax(0,1fr)}[data-vd-filters],[data-vd-flat]{grid-template-columns:minmax(0,1fr)}}
`

    /** 状态带里的一枚小胶囊。tone: ok | bad | null */
    function Chip({ tone, children, mono }) {
      return h('span', { 'data-vd-chip': '', 'data-ok': tone === 'ok' ? '' : undefined, 'data-bad': tone === 'bad' ? '' : undefined },
        h('i', { 'data-vd-dot': '' }),
        mono ? h('span', { 'data-vd-mono': '', title: String(children) }, children) : h('span', null, children))
    }

    /**
     * 可折叠分区。关闭时用 display:none 保留 DOM，避免展开/收起把输入框里的光标状态弄丢。
     * sum 是收起状态下也要能看到的「现在其实是什么」。
     */
    function Section({ title, sum, open: openInit, children }) {
      const [open, setOpen] = React.useState(!!openInit)
      return h('div', { 'data-vd-sec': '' },
        h('button', { 'data-vd-head': '', type: 'button', onClick: () => setOpen((v) => !v), 'aria-expanded': open ? 'true' : 'false' },
          h('span', { 'data-vd-caret': '', style: { transform: open ? 'rotate(90deg)' : 'none' } }, '▶'),
          h('span', { 'data-vd-title': '' }, title),
          h('span', { 'data-vd-sum': '', title: sum ? String(sum) : '' }, sum || '')),
        h('div', { 'data-vd-body': '', style: open ? undefined : { display: 'none' } }, children))
    }

    function Row({ label, note, source, children }) {
      return h('div', { 'data-vd-row': '' },
        h('div', null,
          label ? h('div', { 'data-vd-label': '' }, label) : null,
          note ? h('div', { 'data-vd-note': '' }, note) : null,
          source ? h('div', { 'data-vd-src': '' }, source) : null),
        h('div', { style: { minWidth: 0 } }, children))
    }

    function TextInput({ value, placeholder, onChange }) {
      return h('input', {
        'data-vd-input': '',
        type: 'text',
        placeholder: placeholder || '',
        value: value ?? '',
        spellcheck: false,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function TextField({ label, note, source, value, placeholder, onChange }) {
      return h(Row, { label, note, source }, h(TextInput, { value, placeholder, onChange }))
    }

    function SelectField({ label, note, source, value, options, disabled, onChange }) {
      return h(Row, { label, note, source },
        h('select', {
          'data-vd-input': '',
          value: value ?? options[0][0],
          disabled: !!disabled,
          onChange: (e) => onChange(e.target.value),
        }, options.map(([v, text]) => h('option', { key: v, value: v }, text))))
    }

    function SwitchField({ label, note, source, on, onChange }) {
      return h(Row, { label, note, source },
        h('button', {
          'data-vd-switch': '',
          'data-on': on ? '' : undefined,
          type: 'button',
          'aria-pressed': on ? 'true' : 'false',
          onClick: () => onChange(!on),
        }, h('i', { 'data-vd-dot': '' }), on ? '开' : '关'))
    }

    function Panel() {
      const [state, setState] = React.useState(null)
      const [form, setForm] = React.useState({})
      const [dirty, setDirty] = React.useState({})
      const [saving, setSaving] = React.useState(false)
      const [savedAt, setSavedAt] = React.useState(0)
      const [msg, setMsg] = React.useState(null)
      const [fails, setFails] = React.useState(0)
      const [loginBusy, setLoginBusy] = React.useState('')

      const adopt = (j) => {
        setState(j)
        setForm({ ...j.values })
        setDirty({})
      }
      const load = async (probe) => {
        try { adopt(await jget('/state' + (probe ? '?probe=1' : ''))); setFails(0) }
        catch (e) { setFails((n) => n + 1); setMsg({ tone: 'warn', t: '读设置失败：' + String(e?.message ?? e) }) }
      }
      React.useEffect(() => { load(true) }, [])
      // 定时只刷状态（探测 ffmpeg/登录态），不回灌表单，否则会把正在输入的内容冲掉
      React.useEffect(() => {
        const t = setInterval(async () => {
          try { setState(await jget('/state?probe=1')); setFails(0) } catch (e) { setFails((n) => n + 1) }
        }, 15000)
        return () => clearInterval(t)
      }, [])

      // ---- 实时保存：改动先进 pending，停手 500ms 就发一次；失败保留 pending 并自动重试
      const timer = React.useRef(null)
      const pending = React.useRef({})
      React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

      const flush = React.useCallback(async () => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
        const patch = { ...pending.current }
        const keys = Object.keys(patch)
        if (!keys.length) return
        pending.current = {}
        setSaving(true)
        try {
          const j = await jpost('/config', { patch })
          setState(j)
          setDirty((d) => {
            const next = { ...d }
            for (const k of keys) if (!(k in pending.current)) delete next[k]
            return next
          })
          setSavedAt(Date.now())
          const bad = (j.warnings && j.warnings.length) ? j.warnings.join('；') : ''
          setMsg(bad ? { tone: 'warn', t: bad } : null)
        } catch (e) {
          // 把没存上的值放回去，3 秒后自动重试（期间用户继续改会合并进同一批）
          for (const k of keys) if (!(k in pending.current)) pending.current[k] = patch[k]
          setMsg({ tone: 'warn', t: '保存失败，正在重试：' + String(e?.message ?? e) })
          timer.current = setTimeout(() => { flush() }, 3000)
        } finally { setSaving(false) }
      }, [])

      const schedule = () => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => { flush() }, 500)
      }

      const setKey = (k, v) => {
        setForm((f) => ({ ...f, [k]: v }))
        setDirty((d) => ({ ...d, [k]: true }))
        pending.current[k] = v
        schedule()
      }
      const dirtyCount = Object.keys(dirty).length

      const clock = (ts) => {
        const d = new Date(ts)
        const p = (n) => String(n).padStart(2, '0')
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      }
      // 「重新读取」先把手里的改动存掉，避免把刚敲的字冲掉
      const reread = async () => {
        await flush()
        await load(true)
      }

      // ---- 扫码登录：起来后每 3 秒读一次 state，直到 status.login 不再是 running
      const loginTried = React.useRef(false)
      const doLogin = async (platform) => {
        setLoginBusy(platform)
        setMsg({ tone: 'warn', t: '已打开浏览器窗口，请扫码登录…' })
        try {
          await jpost('/login', { platform })
        } catch (e) {
          setLoginBusy('')
          setMsg({ tone: 'warn', t: '拉起登录失败：' + String(e?.message ?? e) })
          return
        }
        const started = Date.now()
        const timer = setInterval(async () => {
          try {
            const j = await jget('/state?probe=1')
            setState(j)
            setFails(0)
            const lg = (j.status || {}).login
            if (lg && lg.state && lg.state !== 'running') {
              clearInterval(timer)
              setLoginBusy('')
              setMsg(lg.state === 'ok'
                ? { tone: 'good', t: '登录成功' + (lg.account?.name ? '：' + lg.account.name : '') }
                : { tone: 'warn', t: '登录未完成：' + (lg.message || '超时') })
              try { setState(await jget('/state?probe=1')) } catch { /* 下一轮定时刷新兜 */ }
            }
          } catch {            /* 网络抖动，继续等 */
          }
          if (Date.now() - started > 200000) {
            clearInterval(timer)
            setLoginBusy('')
          }
        }, 3000)
      }

      // 进设置页发现当前平台没登录（或还没取到账号名）→ 直接拉起扫码/读取登录态
      React.useEffect(() => {
        if (!state || loginTried.current) return
        if (loginBusy || st.login?.state === 'running') return
        const cur = (state.values || {}).crawlPlatform || 'kuaishou'
        const p = (state.status?.profiles || {})[cur]
        if (!p) return
        if (p.exists && p.account?.name) return
        loginTried.current = true
        doLogin(cur)
      }, [state])

      if (!state) {
        return h('div', { 'data-vd-page': '' },
          msg ? h('div', { 'data-vd-msg': '', 'data-warn': '' }, msg.t) : null,
          h('div', { 'data-vd-bad': '' }, fails >= 3
            ? '读不到插件配置（已试 ' + fails + ' 次）。常见原因：刚装完没重启 DSH；或插件加载失败（看「插件健康」）。'
            : '读设置中…'))
      }

      const st = state.status || {}
      const src = state.sources || {}
      const srcText = (k) => src[k] === 'local' ? '来源：这一页' : src[k] === 'native' ? '来源：DSH 内置设置页' : '来源：默认值'
      const platformLabel = (id) => (PLATFORM_OPTIONS.find(([v]) => v === id) || [, id])[1]
      // 当前标签页 = 批量爬取的平台；接口不提供的项按 PLATFORM_LIMITS 置灰
      const curPlatform = PLATFORM_SUFFIX[form.crawlPlatform] ? form.crawlPlatform : 'kuaishou'
      const fk = (field) => filterKeyOf(field, curPlatform)
      const limits = PLATFORM_LIMITS[curPlatform] || {}
      const pf = (st.crawlFiltersByPlatform || {})[curPlatform] || st.crawlFilters || {}
      const filterText = [
        pf.maxAgeDays > 0 ? '最近 ' + pf.maxAgeDays + ' 天' : '不限时间',
        pf.minLike > 0 ? '点赞 ≥ ' + pf.minLike : '不限点赞',
        pf.minView > 0 ? '播放 ≥ ' + pf.minView : '不限播放',
        '取 ' + (pf.limit || 10) + ' 条',
      ].join(' · ')
      // crawlTuning 里只有「用户真的填了值」的键才出现，其余交给内置默认，所以这里用默认值兜底显示。
      const tuning = st.crawlTuning || {}
      const ms = (v, d) => (Number(v) > 0 ? Number(v) : d)
      const tunText = [
        '并发 ' + ms(form.crawlConcurrency || tuning.concurrency, 6),
        '页间隔 ' + (ms(form.crawlPageDelayMs || tuning.pageDelayMs, 1500) / 1000).toFixed(1) + 's',
        '换词间隙 ' + (ms(form.crawlKeywordGapMs || tuning.keywordGapMs, 800) / 1000).toFixed(1) + 's',
        form.crawlBlockMedia ? '屏蔽媒体' : '不屏蔽媒体',
      ].join(' · ')

      // 账号栏：优先显示登录后拿到的昵称，其次显示「已登录/未登录」
      const profiles = st.profiles || {}
      const acctOf = (id) => {
        const p = profiles[id] || {}
        return p.account?.name || (p.exists ? '已登录' : '未登录')
      }
      const acctSum = '快手 ' + acctOf('kuaishou') + ' · 抖音 ' + acctOf('douyin')

      return h('div', { 'data-vd-page': '' },

        h('div', { 'data-vd-top': '' },
          h(Chip, { tone: st.ffmpeg ? 'ok' : 'bad' }, st.ffmpeg ? 'ffmpeg 就绪' : 'ffmpeg 未找到'),
          h(Chip, { tone: st.ytdlp ? 'ok' : null }, st.ytdlp ? 'yt-dlp 就绪' : 'yt-dlp 未找到'),
          h(Chip, { tone: st.lux ? 'ok' : null }, st.lux ? 'lux 就绪' : 'lux 未找到'),
          h(Chip, { tone: st.loggedIn === true ? 'ok' : null },
            st.loggedIn === true ? 'B站 已登录' : st.loggedIn === false ? 'B站 未登录（480P）' : 'B站 登录态未知'),
          h('div', { 'data-vd-grow': '' }),
          saving
            ? h('span', { 'data-vd-hint': '' }, '保存中…')
            : dirtyCount
              ? h('span', { 'data-vd-hint': '' }, '待保存')
              : savedAt ? h('span', { 'data-vd-hint': '' }, '已保存 ' + clock(savedAt)) : null,
          h('button', { 'data-vd-btn': '', disabled: saving, onClick: reread }, '刷新')),

        msg ? h('div', {
          'data-vd-msg': '',
          'data-good': msg.tone === 'good' ? '' : undefined,
          'data-warn': msg.tone === 'warn' ? '' : undefined,
        }, msg.t) : null,

        h(Section, { title: '保存位置', open: true, sum: st.downloadDir || '—' },
          h(TextField, {
            label: '下载目录',
            note: '单链接与批量都放这里，按平台分子目录',
            placeholder: st.downloadDir || '',
            value: form.downloadDir,
            source: srcText('downloadDir'),
            onChange: (v) => setKey('downloadDir', v),
          }),
          h('div', { 'data-vd-hint': '' }, '落盘：<下载目录>\\<平台>\\<关键词 | 作者名 | 文件名>')),

        h(Section, { title: '下载质量', open: true, sum: (QUALITY_OPTIONS.find(([v]) => v === form.defaultQuality) || [, 'best'])[1] },
          h(SelectField, {
            label: '默认清晰度',
            note: '达不到就自动降档，回报实际档位',
            source: srcText('defaultQuality'),
            value: form.defaultQuality,
            options: QUALITY_OPTIONS,
            onChange: (v) => setKey('defaultQuality', v),
          })),

        h(Section, { title: '批量爬取', open: true, sum: platformLabel(curPlatform) + ' · ' + filterText },
          h('div', { 'data-vd-tabs': '' },
            ...PLATFORM_OPTIONS.map(([v, label]) => h('button', {
              key: v,
              type: 'button',
              'data-vd-tab': '',
              'data-on': curPlatform === v ? '' : undefined,
              onClick: () => setKey('crawlPlatform', v),
            }, label))),
          h(TextField, {
            label: '默认抓取条数',
            note: '留空 = 10 条；只说条数不说就是它',
            placeholder: '10',
            value: form[fk('crawlLimit')],
            source: srcText(fk('crawlLimit')),
            onChange: (v) => setKey(fk('crawlLimit'), v),
          }),
          h('div', { 'data-vd-hint': '' }, '下载前筛选：不达标的在搜索阶段就丢掉，不下载、不占磁盘'),
          h('div', { 'data-vd-filters': '' },
            h('div', { 'data-vd-filter': '' },
              h('div', { 'data-vd-label': '' }, '最近发布'),
              h('select', {
                'data-vd-input': '',
                value: form[fk('crawlMaxAgeDays')] ?? '',
                onChange: (e) => setKey(fk('crawlMaxAgeDays'), e.target.value),
              }, AGE_OPTIONS.map(([v, t]) => h('option', { key: v, value: v }, t)))),
            h('div', { 'data-vd-filter': '' },
              h('div', { 'data-vd-label': '' }, '最低点赞'),
              h('select', {
                'data-vd-input': '',
                value: form[fk('crawlMinLike')] ?? '',
                disabled: !!limits.minLike,
                onChange: (e) => setKey(fk('crawlMinLike'), e.target.value),
              }, LIKE_OPTIONS.map(([v, t]) => h('option', { key: v, value: v }, t))),
              h('div', { 'data-vd-note': '' }, limits.minLike || '快手的「喜欢」等价于点赞')),
            h('div', { 'data-vd-filter': '' },
              h('div', { 'data-vd-label': '' }, '最低播放量'),
              h('select', {
                'data-vd-input': '',
                value: form[fk('crawlMinView')] ?? '',
                disabled: !!limits.minView,
                onChange: (e) => setKey(fk('crawlMinView'), e.target.value),
              }, VIEW_OPTIONS.map(([v, t]) => h('option', { key: v, value: v }, t))),
              h('div', { 'data-vd-note': '' }, limits.minView || '低于它的不下载')))),

        // 进阶：默认收起。这里的值都能被 video_crawl 的单次传参覆盖。
        h(Section, { title: '账号与登录', sum: acctSum },
          h('div', { 'data-vd-acct': '' },
            h('div', { 'data-vd-acct-row': '' },
              h('b', null, 'B站'),
              h('span', { 'data-vd-badge': st.credential ? 'ok' : '' }, st.credential ? '凭证已找到' : '未找到（匿名 480P）')),
            h('div', { 'data-vd-acct-row': '' },
              h('b', null, '快手'),
              h('span', { 'data-vd-badge': profiles.kuaishou?.exists ? 'ok' : '' },
                acctOf('kuaishou')),
              h('button', {
                'data-vd-btn': '',
                type: 'button',
                disabled: loginBusy === 'kuaishou',
                onClick: () => doLogin('kuaishou'),
              }, loginBusy === 'kuaishou' ? '等待扫码…' : '扫码登录')),
            h('div', { 'data-vd-acct-row': '' },
              h('b', null, '抖音'),
              h('span', { 'data-vd-badge': profiles.douyin?.exists ? 'ok' : '' },
                acctOf('douyin')),
              h('button', {
                'data-vd-btn': '',
                type: 'button',
                disabled: loginBusy === 'douyin',
                onClick: () => doLogin('douyin'),
              }, loginBusy === 'douyin' ? '等待扫码…' : '扫码登录'))),
          h(SwitchField, {
            label: '读取本机 B 站凭证',
            note: '关掉 = 匿名（最高 480P）',
            source: srcText('biliUseCredential'),
            on: form.biliUseCredential !== false,
            onChange: (v) => setKey('biliUseCredential', v),
          }),
          h(TextField, {
            label: 'B站 凭证路径',
            note: '留空自动查找',
            placeholder: st.credential || '自动查找',
            value: form.biliCredentialPath,
            source: srcText('biliCredentialPath'),
            onChange: (v) => setKey('biliCredentialPath', v),
          })),

        h(Section, { title: '排障', open: false, sum: tunText },
          h('div', { 'data-vd-hint': '' }, '留空 = 用内置默认值（括号里那个）。这些值决定「会不会被风控」和「一条卡住要等多久」，改之前先看右边说明。'),
          h(TextField, {
            label: '下载并发',
            note: '留空 = 6（B站 会夹到 2）',
            placeholder: String(tuning.concurrency || 6),
            value: form.crawlConcurrency,
            source: srcText('crawlConcurrency'),
            onChange: (v) => setKey('crawlConcurrency', v),
          }),
          h(TextField, {
            label: '翻页间隔（毫秒）',
            note: '留空 = 1500；低于 300 会被风控',
            placeholder: String(tuning.pageDelayMs || 1500),
            value: form.crawlPageDelayMs,
            source: srcText('crawlPageDelayMs'),
            onChange: (v) => setKey('crawlPageDelayMs', v),
          }),
          h(TextField, {
            label: '换关键词停顿（毫秒）',
            note: '留空 = 800，换词前停顿',
            placeholder: String(tuning.keywordGapMs || 800),
            value: form.crawlKeywordGapMs,
            source: srcText('crawlKeywordGapMs'),
            onChange: (v) => setKey('crawlKeywordGapMs', v),
          }),
          h(TextField, {
            label: '等扫码登录（秒）',
            note: '留空 = 180 秒，超时转「等你处理」',
            placeholder: String(Math.round((tuning.loginWaitMs || 180000) / 1000)),
            value: form.crawlLoginWaitSec,
            source: srcText('crawlLoginWaitSec'),
            onChange: (v) => setKey('crawlLoginWaitSec', v),
          }),
          h(TextField, {
            label: '停滞多久断开重连（秒）',
            note: '留空 = 15 秒，无数据即重连',
            placeholder: String(Math.round((tuning.stallMs || 15000) / 1000)),
            value: form.crawlStallSec,
            source: srcText('crawlStallSec'),
            onChange: (v) => setKey('crawlStallSec', v),
          }),
          h(TextField, {
            label: '单条下载总预算（秒）',
            note: '留空 = 300 秒，超时记 failed',
            placeholder: String(Math.round((tuning.totalMs || 300000) / 1000)),
            value: form.crawlDownloadTimeoutSec,
            source: srcText('crawlDownloadTimeoutSec'),
            onChange: (v) => setKey('crawlDownloadTimeoutSec', v),
          }),
          h(SwitchField, {
            label: '搜索时屏蔽图片/视频/字体',
            note: '抖音开了会拿不到数据',
            source: srcText('crawlBlockMedia'),
            on: form.crawlBlockMedia === true,
            onChange: (v) => setKey('crawlBlockMedia', v),
          })),

        h(Section, { title: '高级', open: false, sum: '后端顺序 · 代理 · 组件路径' },
          h(SelectField, {
            label: '非 B站 站点后端顺序',
            note: '默认让它兜底；抖音固定走浏览器',
            source: srcText('genericBackend'),
            value: form.genericBackend,
            options: BACKEND_OPTIONS,
            onChange: (v) => setKey('genericBackend', v),
          }),
          h('div', { 'data-vd-hint': '' },
            '实际顺序：' + ((st.genericOrder && st.genericOrder.length) ? st.genericOrder.join(' → ') : '—')
            + '；只有「这个后端干不了」才换下一个，要登录或被风控时直接报错'),
          h(TextField, {
            label: '代理',
            note: '非 B站 站点共用；B站/快手/抖音强制直连',
            placeholder: '留空 = 不用代理',
            value: form.ytdlpProxy,
            source: srcText('ytdlpProxy'),
            onChange: (v) => setKey('ytdlpProxy', v),
          }),
          h('div', { 'data-vd-hint': '' }, '外部组件：' + [st.ffmpeg, st.ytdlp, st.lux].filter(Boolean).length + ' / 3 已找到（留空 = 自动探测）'),
          h(TextField, {
            label: 'ffmpeg',
            note: '留空 = 自动探测',
            placeholder: st.ffmpeg || '自动探测',
            value: form.ffmpegPath,
            source: srcText('ffmpegPath'),
            onChange: (v) => setKey('ffmpegPath', v),
          }),
          h(TextField, {
            label: 'yt-dlp',
            note: '留空 = 自动探测',
            placeholder: st.ytdlp || '自动探测',
            value: form.ytdlpPath,
            source: srcText('ytdlpPath'),
            onChange: (v) => setKey('ytdlpPath', v),
          }),
          h(TextField, {
            label: 'lux',
            note: '留空 = 自动探测',
            placeholder: st.lux || '自动探测',
            value: form.luxPath,
            source: srcText('luxPath'),
            onChange: (v) => setKey('luxPath', v),
          })),

        h('div', { 'data-vd-foot': '' },
          '优先级：单次工具调用传参 > 这一页 > 环境变量 > 内置默认。留空 = 没设（退回下一层），清空这一页不会让插件失效。'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-video-downloader')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-video-downloader: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : null) || ctx.slots
        if (!slots) return
        // label 就是「设置」左侧导航那一行的名字
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'video-downloader', order: 40, label: '视频下载' },
          () => h(Panel),
        ))
      },
    }
  },
})
