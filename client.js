/**
 * dsh-video-downloader —— 浏览器半端（「设置」左侧栏独立一页：视频下载）
 * ============================================================================
 * ⚠️ client bundle **不是 ESM**，是自注册脚本（DSH 的约定）：
 *     window.__ModuleLoader__.load({ id: '<等于 package.json 的 name>', factory: (require) => ({ inject, apply }) })
 * 进「设置」的办法是往 `settings.section` slot 注册一项（label = 左侧导航那一行），
 * 不要自己糊标题栏按钮 + 全屏遮罩（第一版那样做，一眼就跟别的插件不一样）。
 *
 * 这一页只做两件事：
 *   ① 读 `/api/video-downloader/state` —— 7 项当前生效值 + 只读状态（登录态 / ffmpeg / yt-dlp / 落地目录）
 *   ② 写 `/api/video-downloader/config` —— 保存改动，写完回读核对；失败必须红字，不许绿字骗人
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
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
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
      ['best', 'best —— 跟随账号权限取最高（默认）'],
      ['worst', 'worst —— 取最低（省流量）'],
      ['112', '112 —— 1080P 高码率'],
      ['80', '80 —— 1080P'],
      ['64', '64 —— 720P'],
      ['32', '32 —— 480P'],
      ['16', '16 —— 360P'],
    ]

    const CSS = `
[data-vd-page]{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;font-size:14px;line-height:1.6}
[data-vd-bar]{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0;background:var(--bg-primary,transparent)}
[data-vd-badge]{border:1px solid rgba(127,127,127,.35);border-radius:999px;padding:1px 10px;font-size:12px;opacity:.9;white-space:nowrap}
[data-vd-badge][data-on]{border-color:rgba(46,160,67,.6);color:#2ea043}
[data-vd-badge][data-off]{border-color:rgba(210,90,60,.6);color:#d05a3c}
[data-vd-grow]{flex:1 1 auto}
[data-vd-sec]{display:flex;flex-direction:column;gap:10px;border:1px solid rgba(127,127,127,.22);border-radius:10px;padding:12px 14px}
[data-vd-h]{font-weight:600;font-size:13px;opacity:.75;letter-spacing:.02em}
[data-vd-row]{display:flex;align-items:flex-start;gap:12px}
[data-vd-label]{font-weight:500}
[data-vd-note]{font-size:12px;opacity:.6}
[data-vd-input]{box-sizing:border-box;width:100%;padding:6px 9px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;font-family:inherit;font-size:13px}
[data-vd-input]:focus{outline:2px solid rgba(80,140,255,.45);outline-offset:1px}
[data-vd-btn]{padding:4px 14px;border:1px solid rgba(127,127,127,.4);border-radius:8px;background:transparent;color:inherit;font-family:inherit;font-size:13px;cursor:pointer}
[data-vd-btn][data-primary]{border-color:rgba(80,140,255,.65);color:#3b82f6}
[data-vd-btn]:disabled{opacity:.5;cursor:default}
[data-vd-msg]{border-radius:8px;padding:6px 10px;font-size:12px;border:1px solid rgba(127,127,127,.35)}
[data-vd-msg][data-good]{border-color:rgba(46,160,67,.55);color:#2ea043}
[data-vd-msg][data-warn]{border-color:rgba(210,90,60,.55);color:#d05a3c}
[data-vd-src]{font-size:11px;opacity:.5}
`

    function Toggle(props) {
      return h('div', { 'data-vd-row': '' },
        h('div', { 'data-vd-grow': '' },
          h('div', { 'data-vd-label': '' }, props.label),
          props.note ? h('div', { 'data-vd-note': '' }, props.note) : null),
        h('button', {
          'data-vd-btn': '',
          'aria-pressed': props.on ? 'true' : 'false',
          disabled: props.disabled,
          onClick: () => props.onChange(!props.on),
        }, props.on ? '开' : '关'))
    }

    function Field(props) {
      return h('div', { 'data-vd-row': '' },
        h('div', { 'data-vd-grow': '' },
          h('div', { 'data-vd-label': '' }, props.label),
          props.note ? h('div', { 'data-vd-note': '' }, props.note) : null,
          props.source ? h('div', { 'data-vd-src': '' }, props.source) : null),
        h('div', { style: { width: '52%', maxWidth: '520px' } },
          h('input', {
            'data-vd-input': '',
            type: 'text',
            placeholder: props.placeholder || '',
            value: props.value ?? '',
            spellcheck: false,
            onChange: (e) => props.onChange(e.target.value),
          })))
    }

    function Panel() {
      const [state, setState] = React.useState(null)
      const [form, setForm] = React.useState({})
      const [dirty, setDirty] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [fails, setFails] = React.useState(0)

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
      // 只读状态（登录态要联网探一次）不跟着每次改动刷新，15 秒轮一次就够
      React.useEffect(() => {
        const t = setInterval(() => load(true), 15000)
        return () => clearInterval(t)
      }, [])

      const setKey = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setDirty((d) => ({ ...d, [k]: true })) }

      const save = async () => {
        const patch = {}
        for (const k of Object.keys(dirty)) patch[k] = form[k]
        if (!Object.keys(patch).length) { setMsg({ tone: 'warn', t: '没有改动要保存' }); return }
        setBusy(true); setMsg(null)
        try {
          const j = await jpost('/config', { patch })
          adopt(j)
          const bad = (j.warnings && j.warnings.length) ? j.warnings.join('；') : ''
          setMsg(bad
            ? { tone: 'warn', t: '已保存，但有需要注意的：' + bad }
            : { tone: 'good', t: '已保存' + (j.persisted && j.persisted.length ? '：' + j.persisted.join('、') : '') + '（改完下一条命令就生效，不用重启）' })
        } catch (e) {
          setMsg({ tone: 'warn', t: '保存失败：' + String(e?.message ?? e) })
        } finally { setBusy(false) }
      }

      if (!state) {
        return h('div', { 'data-vd-page': '' },
          msg ? h('div', { 'data-vd-msg': '', 'data-warn': '' }, msg.t) : null,
          h('div', { 'data-vd-note': '' }, fails >= 3
            ? '读不到插件配置（已试 ' + fails + ' 次）。常见原因：刚装完没重启 DSH；或插件加载失败（看「插件健康」）。'
            : '读设置中…'))
      }

      const st = state.status || {}
      const src = state.sources || {}
      const srcText = (k) => src[k] === 'local' ? '当前来源：这一页（面板）' : src[k] === 'native' ? '当前来源：DSH 内置插件设置页' : '当前来源：默认值'

      return h('div', { 'data-vd-page': '' },
        msg ? h('div', { 'data-vd-msg': '', 'data-good': msg.tone === 'good' ? '' : undefined, 'data-warn': msg.tone === 'warn' ? '' : undefined }, msg.t) : null,

        h('div', { 'data-vd-bar': '' },
          h('span', { 'data-vd-badge': '', 'data-on': st.loggedIn === true ? '' : undefined, 'data-off': st.loggedIn === false ? '' : undefined },
            st.loggedIn === true ? 'B站 已登录（清晰度跟账号权限）' : st.loggedIn === false ? 'B站 未登录（最高 480P）' : 'B站 登录态未知'),
          h('span', { 'data-vd-badge': '', 'data-on': st.ffmpeg ? '' : undefined, 'data-off': st.ffmpeg ? undefined : '' },
            st.ffmpeg ? 'ffmpeg 就绪' : 'ffmpeg 未找到'),
          h('span', { 'data-vd-badge': '', 'data-on': st.ytdlp ? '' : undefined },
            st.ytdlp ? 'yt-dlp 就绪' : 'yt-dlp 未找到'),
          h('div', { 'data-vd-grow': '' }),
          h('button', { 'data-vd-btn': '', 'data-primary': '', disabled: busy, onClick: save },
            busy ? '保存中…' : '保存'),
          h('button', { 'data-vd-btn': '', disabled: busy, onClick: () => load(true) }, '重新读取')),

        h('div', { 'data-vd-sec': '' },
          h('div', { 'data-vd-h': '' }, '下载落点'),
          h(Field, {
            label: '默认下载目录',
            note: '留空 = 系统 Downloads\\dsh-video-downloader；目录不存在会自动创建',
            placeholder: st.downloadDir || '',
            value: form.downloadDir,
            source: srcText('downloadDir'),
            onChange: (v) => setKey('downloadDir', v),
          }),
          h('div', { 'data-vd-note': '' }, '现在实际落在：' + (st.downloadDir || '—'))),

        h('div', { 'data-vd-sec': '' },
          h('div', { 'data-vd-h': '' }, '清晰度'),
          h('div', { 'data-vd-row': '' },
            h('div', { 'data-vd-grow': '' },
              h('div', { 'data-vd-label': '' }, '默认清晰度偏好'),
              h('div', { 'data-vd-note': '' }, '没有权限的档位会自动降到账号可达的最高档，回报的是实际档位'),
              h('div', { 'data-vd-src': '' }, srcText('defaultQuality'))),
            h('div', { style: { width: '52%', maxWidth: '520px' } },
              h('select', {
                'data-vd-input': '',
                value: form.defaultQuality || 'best',
                onChange: (e) => setKey('defaultQuality', e.target.value),
              }, QUALITY_OPTIONS.map(([v, label]) => h('option', { key: v, value: v }, label)))))),

        h('div', { 'data-vd-sec': '' },
          h('div', { 'data-vd-h': '' }, 'B站 登录态'),
          h(Toggle, {
            label: '读取本机 B 站登录凭证',
            note: '关掉 = 纯匿名，最高只到 480P；凭证内容不进面板，这里只存路径',
            on: form.biliUseCredential !== false,
            onChange: (v) => setKey('biliUseCredential', v),
          }),
          h(Field, {
            label: '凭证文件路径',
            note: '留空 = 按顺序自动查找（DSH_BILI_CREDENTIAL → %APPDATA%\\dsh-desktop\\harness\\bili-duty → $DSH_HOME / ~/.dsh）',
            placeholder: st.credential || '自动查找',
            value: form.biliCredentialPath,
            source: srcText('biliCredentialPath'),
            onChange: (v) => setKey('biliCredentialPath', v),
          }),
          h('div', { 'data-vd-note': '' }, st.credential
            ? '找到的凭证文件：' + st.credential
            : '没找到凭证文件（此时自动退回匿名 480P）')),

        h('div', { 'data-vd-sec': '' },
          h('div', { 'data-vd-h': '' }, '外部组件'),
          h(Field, {
            label: 'ffmpeg 路径',
            note: '留空 = 自动探测；填错会退回自动探测，不会让下载直接失败',
            placeholder: st.ffmpeg || '自动探测',
            value: form.ffmpegPath,
            source: srcText('ffmpegPath'),
            onChange: (v) => setKey('ffmpegPath', v),
          }),
          h(Field, {
            label: 'yt-dlp 路径',
            note: '留空 = 自动探测；非 B站 站点（抖音、小红书、YouTube…）用它',
            placeholder: st.ytdlp || '自动探测',
            value: form.ytdlpPath,
            source: srcText('ytdlpPath'),
            onChange: (v) => setKey('ytdlpPath', v),
          }),
          h(Field, {
            label: 'yt-dlp 代理',
            note: '只作用于非 B站 站点；B站 与抖音强制直连。例：http://127.0.0.1:7890',
            placeholder: '留空 = 不用代理',
            value: form.ytdlpProxy,
            source: srcText('ytdlpProxy'),
            onChange: (v) => setKey('ytdlpProxy', v),
          })),

        h('div', { 'data-vd-note': '' },
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
