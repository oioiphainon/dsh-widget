/**
 * Client half of the 大肥鱼 task-progress floating widget.
 *
 * Registers one entry in the frame-wide `shell.overlay` slot: a draggable mascot
 * (the user's fish-girl artwork) plus a speech bubble and an expandable panel
 * that show the live progress the Host half serves at
 * `/api/fat-fish/progress` — phase, turn/step, the tool currently running, the
 * latest todo list, background jobs, the session goal and team tasks.
 *
 * Everything is drawn with the Harness theme tokens; the artwork keeps its own
 * colors. Position, size and the collapsed/expanded/minimized mode live in
 * localStorage so the widget survives reloads.
 *
 * NOTE: this file is a source template. `scripts/build-client.mjs` replaces the
 * `__FISH_B64__` token with the base64 cutout and writes `client.js` (the file
 * the module loader serves).
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-fat-fish-widget',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API_PATH = '/api/fat-fish/progress'
    const POLL_MS = 1200
    const TICK_MS = 1000
    const MASCOT_BASE = 104
    const FISH_SRC = 'data:image/png;base64,__FISH_B64__'
    const SIZES = [0.84, 1, 1.18]
    const STORE = {
      mode: 'dsh-fat-fish.mode',
      pos: 'dsh-fat-fish.pos',
      scale: 'dsh-fat-fish.scale',
      seen: 'dsh-fat-fish.seen',
    }

    const DICT = {
      zh: {
        title: '大肥鱼 · 任务进度',
        connecting: '正在读取进度…',
        offline: '连不上进度接口，正在重试…',
        queued: '排队中…',
        thinking: '思考中…',
        streaming: '输出中…',
        tool: '干活中',
        idle: '摸鱼中…',
        done: '完成',
        error: '出错了',
        idle1: '摸鱼中，有活儿随时喊我',
        idle2: '伸个懒腰~',
        idle3: '水面很平静',
        idle4: '在的，发个任务吧',
        noTask: '暂时没有正在进行的任务',
        noTaskHint: '发一条消息，我就开始记进度',
        todo: '任务清单',
        todoNone: '这次还没写清单',
        progress: '完成度',
        current: '正在做',
        goal: '目标',
        jobs: '后台任务',
        team: '团队任务',
        others: '另有 {n} 个会话在跑',
        collapse: '收起面板',
        minimize: '收成小鱼',
        restore: '展开面板',
        refresh: '刷新',
        size: '大小',
        reset: '重置位置',
        tabHint: '点我展开大肥鱼',
        swipeHint: '拖动可以移动我',
        doneToast: '搞定！',
        round: '第 {n} 轮',
        step: '第 {n} 步',
        tools: '{n} 次工具',
        elapsed: '用时 {time}',
        rounds: '第 {a}/{b} 轮',
        todoCount: '{done}/{total} 完成',
        jobRunning: '进行中',
        jobDone: '已完成',
        jobStopped: '已停止',
        jobFailed: '失败',
        noData: '—',
        more: '还有 {n} 条',
      },
      en: {
        title: 'Fat Fish · task progress',
        connecting: 'Reading progress…',
        offline: 'Cannot reach the progress service, retrying…',
        queued: 'Queued…',
        thinking: 'Thinking…',
        streaming: 'Writing…',
        tool: 'Working',
        idle: 'Goofing off…',
        done: 'Done',
        error: 'Error',
        idle1: 'Idle — give me something to do',
        idle2: 'Stretching~',
        idle3: 'The water is calm',
        idle4: 'Here — send a task',
        noTask: 'No task running right now',
        noTaskHint: 'Send a message and I start counting',
        todo: 'Task list',
        todoNone: 'No list yet this time',
        progress: 'Progress',
        current: 'Doing',
        goal: 'Goal',
        jobs: 'Background jobs',
        team: 'Team tasks',
        others: '{n} more sessions running',
        collapse: 'Collapse panel',
        minimize: 'Shrink to a fish tab',
        restore: 'Expand panel',
        refresh: 'Refresh',
        size: 'Size',
        reset: 'Reset position',
        tabHint: 'Click to expand Fat Fish',
        swipeHint: 'Drag me anywhere',
        doneToast: 'All done!',
        round: 'turn {n}',
        step: 'step {n}',
        tools: '{n} tools',
        elapsed: '{time} elapsed',
        rounds: 'round {a}/{b}',
        todoCount: '{done}/{total} done',
        jobRunning: 'running',
        jobDone: 'done',
        jobStopped: 'stopped',
        jobFailed: 'failed',
        noData: '—',
        more: '{n} more',
      },
    }

    /** Friendly Chinese names for the tools this widget is likely to show. */
    const TOOL_ZH = {
      read: '读文件',
      write: '写文件',
      edit: '改文件',
      glob: '找文件',
      grep: '搜索内容',
      pwsh: '终端',
      bash: '终端',
      todo_write: '更新清单',
      job_list: '看后台任务',
      job_output: '读任务输出',
      job_kill: '停后台任务',
      list_agents: '看队友',
      send_message: '发消息',
      spawn_teammate: '叫队友',
      interrupt_agent: '打断队友',
      wait_agent: '等队友',
      team_task_create: '建任务',
      team_task_get: '看任务',
      team_task_list: '列任务',
      team_task_update: '改任务',
      workflow: '跑工作流',
      subagent: '派小助手',
      subagent_fork: '派小助手',
      web_search: '联网搜索',
      web_fetch: '读网页',
      skill: '加载技能',
      ask_user_question: '询问你',
      create_goal: '立目标',
      update_goal: '更新目标',
      get_goal: '看目标',
      present: '展示文件',
      read_image: '看图片',
      visualize: '画图',
      cordis_inspect_list: '查看接口',
      cordis_inspect_query: '查看接口',
      cordis_define: '写动态插件',
      cordis_run: '跑动态插件',
      schedule_create: '排日程',
      schedule_list: '看日程',
      schedule_update: '改日程',
      schedule_delete: '删日程',
      terminal_open: '开终端',
      terminal_read: '读终端',
      terminal_close: '关终端',
    }

    /** CSS for every widget part; tokens are the only shared styling dependency. */
    const CSS = `
.ff-root{position:fixed;z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:9px;pointer-events:none;font-family:inherit;user-select:none;-webkit-user-select:none}
.ff-fishwrap{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
.ff-mascot{position:relative;border:0;padding:0;margin:0;background:transparent;display:grid;place-items:center;cursor:grab;pointer-events:auto;touch-action:none;outline:none;border-radius:50%;transition:transform .18s ease}
.ff-mascot:hover{transform:translateY(-2px)}
.ff-mascot.ff-dragging{cursor:grabbing;transition:none;transform:none}
.ff-mascot:focus-visible .ff-disc{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary),0 10px 26px rgba(10,25,50,.22)}
.ff-disc{position:absolute;inset:0;border-radius:50%;background:rgba(255,255,255,.86);background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 86%,transparent);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 10px 26px rgba(10,25,50,.2);transition:transform .25s cubic-bezier(.2,.8,.2,1)}
.ff-mascot:hover .ff-disc{transform:scale(1.03)}
.ff-ring{position:absolute;inset:-7px;border-radius:50%;background:conic-gradient(from 0deg,transparent 0 66%,var(--dsw-alias-brand-primary) 90%,transparent 100%);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));animation:ff-spin 2.4s linear infinite;opacity:0;transition:opacity .35s}
.ff-running .ff-ring{opacity:.95}
.ff-img{position:relative;width:84%;height:84%;object-fit:contain;filter:drop-shadow(0 5px 7px rgba(16,38,74,.22));transform:translateY(2%);animation:ff-breathe 4.8s ease-in-out infinite;pointer-events:none;-webkit-user-drag:none}
.ff-running .ff-img{animation:ff-swim 1.45s ease-in-out infinite}
.ff-done .ff-img{animation:ff-hop .62s ease-in-out 4}
.ff-bubble{position:relative;max-width:238px;padding:8px 11px;border-radius:14px;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.45;box-shadow:0 10px 26px rgba(10,25,50,.18);pointer-events:none;animation:ff-in .22s ease-out}
.ff-bubble:after{content:"";position:absolute;right:26px;bottom:-6px;width:11px;height:11px;background:var(--dsw-alias-bg-overlay,#fff);border-right:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);transform:rotate(45deg)}
.ff-bline{display:flex;align-items:center;gap:6px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ff-bsub{margin-top:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ff-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:ff-pulse 1.1s ease-in-out infinite}
.ff-dot.ff-dot-idle{background:var(--dsw-alias-state-idle-primary);animation:none}
.ff-dot.ff-dot-done{background:var(--dsw-alias-state-success-primary);animation:none}
.ff-dot.ff-dot-error{background:var(--dsw-alias-state-error-primary);animation:none}
.ff-bar{position:relative;height:5px;margin-top:6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent);overflow:hidden}
.ff-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),var(--dsw-alias-state-success-primary));transition:width .5s cubic-bezier(.2,.8,.2,1)}
.ff-fill.ff-indet{width:38%;animation:ff-slide 1.35s ease-in-out infinite}
.ff-panel{pointer-events:auto;width:272px;max-width:min(300px,80vw);max-height:min(70vh,560px);display:flex;flex-direction:column;border-radius:16px;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 20px 48px rgba(8,18,40,.24);overflow:hidden;animation:ff-in .2s ease-out;color:var(--dsw-alias-label-primary);font-size:12.5px}
.ff-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent),transparent)}
.ff-title{flex:1;min-width:0;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ff-pill{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);white-space:nowrap}
.ff-pill.ff-pill-done{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}
.ff-pill.ff-pill-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 15%,transparent);color:var(--dsw-alias-state-error-primary)}
.ff-pill.ff-pill-idle{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);color:var(--dsw-alias-label-secondary)}
.ff-xbtn{flex:none;width:22px;height:22px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;display:grid;place-items:center}
.ff-xbtn:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);color:var(--dsw-alias-label-primary)}
.ff-body{overflow:auto;padding:0 12px 10px;scrollbar-width:thin}
.ff-prog{margin:2px 0 8px;padding:9px 10px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.ff-prog-top{display:flex;align-items:baseline;gap:6px}
.ff-prog-num{font-size:15px;font-weight:700;letter-spacing:.2px}
.ff-prog-lbl{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ff-stats{margin-top:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;flex-wrap:wrap;gap:2px 8px}
.ff-row{display:flex;align-items:flex-start;gap:6px;padding:4px 0;line-height:1.4}
.ff-row-key{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:52px}
.ff-row-val{flex:1;min-width:0;word-break:break-word}
.ff-sec{margin-top:8px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);padding-top:7px}
.ff-sec-h{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:3px}
.ff-muted{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.ff-todo{display:flex;align-items:flex-start;gap:6px;padding:2.5px 0;line-height:1.42}
.ff-tick{flex:none;width:13px;text-align:center;font-size:11px;margin-top:1px;color:var(--dsw-alias-state-idle-primary)}
.ff-todo-in_progress .ff-tick{color:var(--dsw-alias-brand-primary)}
.ff-todo-completed .ff-tick{color:var(--dsw-alias-state-success-primary)}
.ff-todo-completed .ff-todotext{color:var(--dsw-alias-label-secondary);text-decoration:line-through}
.ff-todo-in_progress .ff-todotext{font-weight:600}
.ff-todotext{flex:1;min-width:0;word-break:break-word}
.ff-job{display:flex;align-items:center;gap:6px;padding:2.5px 0;line-height:1.4}
.ff-job-lbl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ff-job-st{flex:none;font-size:10.5px;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-idle-primary) 16%,transparent);color:var(--dsw-alias-label-secondary)}
.ff-job-st.ff-job-running{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary)}
.ff-job-st.ff-job-failed{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 15%,transparent);color:var(--dsw-alias-state-error-primary)}
.ff-job-st.ff-job-completed{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:var(--dsw-alias-state-success-primary)}
.ff-foot{display:flex;align-items:center;gap:6px;padding:8px 10px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}
.ff-btn{height:24px;min-width:26px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11.5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;font-family:inherit}
.ff-btn:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1))}
.ff-btn:active{transform:translateY(1px)}
.ff-spacer{flex:1}
.ff-tab{pointer-events:auto;width:38px;height:38px;padding:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 8px 22px rgba(10,25,50,.2);cursor:pointer;overflow:hidden;display:grid;place-items:center;opacity:.8;transition:opacity .2s ease,transform .2s ease}
.ff-tab:hover{opacity:1;transform:scale(1.08)}
.ff-tab img{width:150%;height:150%;object-fit:contain;object-position:50% 16%;pointer-events:none}
.ff-spark{position:absolute;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);pointer-events:none;animation:ff-spark .95s ease-out forwards}
@keyframes ff-in{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}
@keyframes ff-breathe{0%,100%{transform:translateY(2%) scale(1)}50%{transform:translateY(.5%) scale(1.025)}}
@keyframes ff-swim{0%,100%{transform:translateY(0) rotate(-1.8deg)}50%{transform:translateY(-5%) rotate(1.8deg)}}
@keyframes ff-hop{0%,100%{transform:translateY(0)}32%{transform:translateY(-15%) rotate(-4deg)}68%{transform:translateY(-4%) rotate(3deg)}}
@keyframes ff-spin{to{transform:rotate(360deg)}}
@keyframes ff-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
@keyframes ff-slide{0%{left:-38%}100%{left:100%}}
@keyframes ff-spark{0%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--ff-dx,0),var(--ff-dy,-26px)) scale(.3)}}
@media (prefers-reduced-motion: reduce){
.ff-img,.ff-ring,.ff-dot,.ff-fill.ff-indet,.ff-spark{animation:none!important}
}
`

    /* ---------------------------------------------------------------- helpers */

    function readStore(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return fallback
        return JSON.parse(raw)
      } catch (error) {
        return fallback
      }
    }

    function writeStore(key, value) {
      try {
        if (value === null || value === undefined) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, JSON.stringify(value))
      } catch (error) {
        /* private mode / quota: the widget simply forgets its layout */
      }
    }

    function clamp(value, low, high) {
      return Math.min(high, Math.max(low, value))
    }

    function normalizeMode(value) {
      return value === 'expanded' || value === 'minimized' ? value : 'collapsed'
    }

    /** `82345` → `01:23`; `3723456` → `1:02:03`. */
    function fmtDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
      const total = Math.floor(ms / 1000)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      const pad = (n) => String(n).padStart(2, '0')
      return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
    }

    function oneLine(text, max) {
      if (typeof text !== 'string') return ''
      const flat = text.replace(/\s+/g, ' ').trim()
      return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
    }

    /** Translate one key, filling `{name}` placeholders. */
    function translator(lang) {
      const dict = DICT[lang] || DICT.zh
      return function t(key, params) {
        const raw = dict[key] !== undefined ? dict[key] : DICT.zh[key] !== undefined ? DICT.zh[key] : key
        if (params === undefined) return raw
        return String(raw).replace(/\{(\w+)\}/g, (match, name) =>
          params[name] !== undefined && params[name] !== null ? String(params[name]) : match,
        )
      }
    }

    function langOf(active) {
      return typeof active === 'string' && active.toLowerCase().startsWith('en') ? 'en' : 'zh'
    }

    /** Follow the host locale service so visible copy switches with the app. */
    function useLang(locale) {
      const [active, setActive] = useState(() => {
        try {
          return locale === undefined ? undefined : locale.getSnapshot().active
        } catch (error) {
          return undefined
        }
      })
      useEffect(() => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        const read = () => {
          try {
            setActive(locale.getSnapshot().active)
          } catch (error) {
            /* a disposed service: keep the last language */
          }
        }
        read()
        return locale.subscribe(read)
      }, [locale])
      return langOf(active)
    }

    /** GET the progress document; a failure is reported, never thrown. */
    async function fetchProgress(signal) {
      const url = new URL(API_PATH.replace(/^\/+/, ''), document.baseURI).href
      const response = await fetch(url, {
        signal,
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body === null || typeof body !== 'object' || body.ok !== true) throw new Error('bad payload')
      return body
    }

    /** Phase → pill class + dot class. */
    function phaseClass(phase) {
      if (phase === 'done') return 'ff-pill-done'
      if (phase === 'error') return 'ff-pill-error'
      if (phase === 'idle') return 'ff-pill-idle'
      return ''
    }

    function dotClass(phase) {
      if (phase === 'done') return 'ff-dot ff-dot-done'
      if (phase === 'error') return 'ff-dot ff-dot-error'
      if (phase === 'idle' || phase === 'queued') return 'ff-dot ff-dot-idle'
      return 'ff-dot'
    }

    /** Job status → label key. */
    function jobKey(status) {
      if (status === 'running' || status === 'stopping') return 'jobRunning'
      if (status === 'completed') return 'jobDone'
      if (status === 'failed') return 'jobFailed'
      return 'jobStopped'
    }

    /* -------------------------------------------------------------- component */

    function createWidget(locale) {
      return function FatFishWidget() {
        const [snap, setSnap] = useState({ data: null, error: null, at: 0 })
        const [mode, setModeState] = useState(() => normalizeMode(readStore(STORE.mode, 'collapsed')))
        const [pos, setPos] = useState(() => {
          const saved = readStore(STORE.pos, null)
          return saved !== null && typeof saved === 'object' && typeof saved.x === 'number' && typeof saved.y === 'number'
            ? { x: saved.x, y: saved.y }
            : null
        })
        const [sizeIndex, setSizeIndex] = useState(() => {
          const saved = readStore(STORE.scale, 1)
          const index = SIZES.indexOf(saved)
          return index >= 0 ? index : 1
        })
        const [now, setNow] = useState(() => Date.now())
        const [dragging, setDragging] = useState(false)
        const [celebrateUntil, setCelebrateUntil] = useState(0)
        const [hint, setHint] = useState(() => readStore(STORE.seen, false) !== true)
        const [reload, setReload] = useState(0)
        const dragRef = useRef(null)
        const rootRef = useRef(null)
        const snapRef = useRef(snap)
        snapRef.current = snap
        const posRef = useRef(pos)
        posRef.current = pos
        const modeRef = useRef(mode)
        modeRef.current = mode
        const lang = useLang(locale)
        const t = useMemo(() => translator(lang), [lang])

        const setMode = useCallback((next) => {
          setModeState(next)
          modeRef.current = next
          writeStore(STORE.mode, next)
        }, [])

        const toggleMode = useCallback(() => {
          setMode(modeRef.current === 'expanded' ? 'collapsed' : 'expanded')
        }, [setMode])

        /* ---------------------------------------------------------- data feed */
        useEffect(() => {
          let disposed = false
          let controller = null
          const load = async () => {
            if (controller !== null) controller.abort()
            controller = new AbortController()
            try {
              const body = await fetchProgress(controller.signal)
              if (disposed) return
              const previous = snapRef.current.data
              const previousPhase = previous && previous.sessions && previous.sessions[0] ? previous.sessions[0].phase : null
              const nextPhase = body.sessions && body.sessions[0] ? body.sessions[0].phase : null
              setSnap({ data: body, error: null, at: Date.now() })
              if (previousPhase !== null && nextPhase !== null && previousPhase !== nextPhase && nextPhase === 'done') {
                setCelebrateUntil(Date.now() + 6500)
              }
            } catch (error) {
              if (disposed || (error && error.name === 'AbortError')) return
              setSnap((current) => ({ ...current, error: String((error && error.message) || error) }))
            }
          }
          load()
          const timer = setInterval(() => {
            if (!document.hidden) load()
          }, POLL_MS)
          const onVisible = () => {
            if (!document.hidden) load()
          }
          window.addEventListener('focus', onVisible)
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            disposed = true
            if (controller !== null) controller.abort()
            clearInterval(timer)
            window.removeEventListener('focus', onVisible)
            document.removeEventListener('visibilitychange', onVisible)
          }
        }, [reload])

        /* Elapsed time keeps ticking between polls. */
        useEffect(() => {
          const timer = setInterval(() => setNow(Date.now()), TICK_MS)
          return () => clearInterval(timer)
        }, [])

        /* First-run hint, shown once. */
        useEffect(() => {
          if (!hint) return undefined
          const timer = setTimeout(() => {
            setHint(false)
            writeStore(STORE.seen, true)
          }, 10000)
          return () => clearTimeout(timer)
        }, [hint])

        /* Keep the saved position inside the viewport. */
        useEffect(() => {
          const onResize = () => {
            setPos((current) => current === null
              ? current
              : {
                x: clamp(current.x, 4, Math.max(4, window.innerWidth - 56)),
                y: clamp(current.y, 4, Math.max(4, window.innerHeight - 56)),
              })
          }
          window.addEventListener('resize', onResize)
          return () => window.removeEventListener('resize', onResize)
        }, [])

        /* Expanding near an edge must not push the panel off-screen. */
        useEffect(() => {
          const node = rootRef.current
          if (node === null || mode === 'minimized') return undefined
          const frame = requestAnimationFrame(() => {
            const rect = node.getBoundingClientRect()
            const overRight = rect.right - (window.innerWidth - 6)
            const overBottom = rect.bottom - (window.innerHeight - 6)
            if (overRight <= 0 && overBottom <= 0) return
            setPos((current) => {
              if (current === null) return current
              return {
                x: clamp(current.x - Math.max(0, overRight), 4, Math.max(4, window.innerWidth - 56)),
                y: clamp(current.y - Math.max(0, overBottom), 4, Math.max(4, window.innerHeight - 56)),
              }
            })
          })
          return () => cancelAnimationFrame(frame)
        }, [mode, sizeIndex])

        /* ---------------------------------------------------------- drag/tap */
        const onPointerDown = useCallback((event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return
          const node = event.currentTarget
          const rect = node.getBoundingClientRect()
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: rect.left,
            originY: rect.top,
            moved: false,
          }
          try {
            node.setPointerCapture(event.pointerId)
          } catch (error) {
            /* pointer capture is a nicety */
          }
        }, [])

        const onPointerMove = useCallback((event) => {
          const drag = dragRef.current
          if (drag === null || drag.pointerId !== event.pointerId) return
          const dx = event.clientX - drag.startX
          const dy = event.clientY - drag.startY
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return
          drag.moved = true
          setDragging(true)
          setPos({
            x: clamp(drag.originX + dx, 4, Math.max(4, window.innerWidth - 56)),
            y: clamp(drag.originY + dy, 4, Math.max(4, window.innerHeight - 56)),
          })
        }, [])

        const onPointerUp = useCallback((event) => {
          const drag = dragRef.current
          if (drag === null || drag.pointerId !== event.pointerId) return
          dragRef.current = null
          setDragging(false)
          try {
            event.currentTarget.releasePointerCapture(event.pointerId)
          } catch (error) {
            /* ignore */
          }
          if (drag.moved) writeStore(STORE.pos, posRef.current)
          else toggleMode()
        }, [toggleMode])

        const resetPos = useCallback(() => {
          setPos(null)
          writeStore(STORE.pos, null)
        }, [])

        const cycleSize = useCallback(() => {
          setSizeIndex((current) => {
            const next = (current + 1) % SIZES.length
            writeStore(STORE.scale, SIZES[next])
            return next
          })
        }, [])

        /* --------------------------------------------------------- view data */
        const data = snap.data
        const sessions = (data && Array.isArray(data.sessions)) ? data.sessions : []
        const active = sessions.length > 0 ? sessions[0] : null
        const otherRunning = sessions.slice(1).filter((session) => session && session.running === true).length
        const activePhase = active ? String(active.phase || 'idle') : 'idle'
        const running = active ? active.running === true : false
        const doneFlash = celebrateUntil > now
        const toolName = active && active.currentTool && typeof active.currentTool.name === 'string' ? active.currentTool.name : null
        const toolText = toolName === null ? null : lang === 'zh' ? (TOOL_ZH[toolName] || toolName) : toolName
        const todoProgress = active && active.todoProgress && typeof active.todoProgress.total === 'number' ? active.todoProgress : null
        const todoPercent = todoProgress !== null && todoProgress.total > 0
          ? clamp(Math.round((todoProgress.done / todoProgress.total) * 100), 0, 100)
          : null
        const turnStartedAt = active && typeof active.turnStartedAt === 'number' ? active.turnStartedAt : null
        const elapsed = running && turnStartedAt !== null
          ? now - turnStartedAt
          : active && typeof active.elapsedMs === 'number'
            ? active.elapsedMs
            : !running && turnStartedAt !== null && active && typeof active.lastEventAt === 'number'
              ? Math.max(0, active.lastEventAt - turnStartedAt)
              : null
        const title = active && typeof active.title === 'string' && active.title.trim() !== '' ? active.title : t('title')
        const idleKeys = ['idle1', 'idle2', 'idle3', 'idle4']
        const idleLine = t(idleKeys[Math.floor(now / 22000) % idleKeys.length])

        let statusText = t('connecting')
        if (data === null && snap.error !== null) statusText = t('offline')
        else if (data === null) statusText = t('connecting')
        else if (doneFlash) statusText = t('doneToast')
        else if (active === null) statusText = idleLine
        else if (activePhase === 'tool') statusText = toolText === null ? t('tool') : `${t('tool')} · ${toolText}`
        else statusText = t(activePhase)

        const parts = []
        if (active !== null) {
          if (typeof active.turn === 'number' && active.turn > 0) parts.push(t('round', { n: active.turn }))
          if (typeof active.step === 'number' && active.step > 0) parts.push(t('step', { n: active.step }))
          if (active.counts && typeof active.counts.tools === 'number') parts.push(t('tools', { n: active.counts.tools }))
          if (elapsed !== null) parts.push(t('elapsed', { time: fmtDuration(elapsed) }))
        }
        const statsText = parts.join(' · ')

        const showBubble = mode === 'collapsed'
        const mSize = Math.round(MASCOT_BASE * SIZES[sizeIndex])

        /* ------------------------------------------------------------ pieces */
        const styleTag = h('style', { key: 'ff-style' }, CSS)

        const sparkles = doneFlash
          ? [0, 1, 2, 3, 4, 5].map((index) => h('span', {
            key: `spark-${index}`,
            className: 'ff-spark',
            style: {
              left: `${34 + ((index * 37) % 44)}%`,
              top: `${26 + ((index * 53) % 40)}%`,
              animationDelay: `${index * 90}ms`,
              '--ff-dx': `${(index % 2 === 0 ? 1 : -1) * (10 + index * 4)}px`,
              '--ff-dy': `${-20 - index * 7}px`,
            },
          }))
          : null

        const mascot = h('button', {
          key: 'mascot',
          type: 'button',
          className: [
            'ff-mascot',
            running ? 'ff-running' : '',
            doneFlash ? 'ff-done' : '',
            dragging ? 'ff-dragging' : '',
          ].filter(Boolean).join(' '),
          style: { width: `${mSize}px`, height: `${mSize}px` },
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleMode()
            } else if (event.key === 'Escape') {
              setMode('collapsed')
            }
          },
          title: t('title'),
          'aria-label': `${t('title')} — ${statusText}`,
          'aria-expanded': mode === 'expanded',
        },
          h('span', { key: 'ring', className: 'ff-ring' }),
          h('span', { key: 'disc', className: 'ff-disc' }),
          h('img', { key: 'img', className: 'ff-img', src: FISH_SRC, alt: '', draggable: false }),
          sparkles,
        )

        const bubble = showBubble && (running || doneFlash || (data === null) || hint || activePhase === 'error')
          ? h('div', { key: 'bubble', className: 'ff-bubble', role: 'status', 'aria-live': 'polite' },
            h('div', { className: 'ff-bline' },
              h('span', { className: dotClass(activePhase) }),
              h('span', { className: 'ff-btext' }, statusText),
            ),
            statsText !== '' ? h('div', { className: 'ff-bsub' }, statsText) : null,
            todoPercent !== null
              ? h('div', { className: 'ff-bar' }, h('div', { className: 'ff-fill', style: { width: `${todoPercent}%` } }))
              : running
                ? h('div', { className: 'ff-bar' }, h('div', { className: 'ff-fill ff-indet' }))
                : null,
            hint ? h('div', { className: 'ff-bsub' }, t('swipeHint')) : null,
          )
          : null

        const todos = active && Array.isArray(active.todos) ? active.todos : []
        const jobs = active && Array.isArray(active.jobs) ? active.jobs : []
        const teamTasks = active && Array.isArray(active.teamTasks) ? active.teamTasks : null
        const goal = active && active.goal && typeof active.goal === 'object' ? active.goal : null

        const progressBlock = h('div', { key: 'prog', className: 'ff-prog' },
          h('div', { className: 'ff-prog-top' },
            h('span', { className: 'ff-prog-num' }, todoPercent === null ? t('noData') : `${todoPercent}%`),
            h('span', { className: 'ff-prog-lbl' }, todoPercent === null ? t('progress') : t('todoCount', { done: todoProgress.done, total: todoProgress.total })),
          ),
          todoPercent !== null
            ? h('div', { className: 'ff-bar' }, h('div', { className: 'ff-fill', style: { width: `${todoPercent}%` } }))
            : running
              ? h('div', { className: 'ff-bar' }, h('div', { className: 'ff-fill ff-indet' }))
              : null,
          statsText !== '' ? h('div', { className: 'ff-stats' }, statsText) : null,
        )

        const currentRow = active !== null && activePhase === 'tool' && toolText !== null
          ? h('div', { key: 'cur', className: 'ff-row' },
            h('span', { className: 'ff-row-key' }, t('current')),
            h('span', { className: 'ff-row-val' },
              h('span', { className: dotClass('tool'), style: { display: 'inline-block', marginRight: '6px', verticalAlign: 'middle' } }),
              toolText,
              active.currentTool && typeof active.currentTool.target === 'string' && active.currentTool.target !== ''
                ? h('span', { className: 'ff-muted' }, ` · ${oneLine(active.currentTool.target, 40)}`)
                : null,
            ),
          )
          : null

        const goalBlock = goal !== null
          ? h('div', { key: 'goal', className: 'ff-sec' },
            h('div', { className: 'ff-sec-h' }, `🎯 ${t('goal')}`),
            h('div', { className: 'ff-row' },
              h('span', { className: 'ff-row-val' }, oneLine(String(goal.objective || ''), 90)),
            ),
            typeof goal.maxGoalRounds === 'number' && goal.maxGoalRounds > 0
              ? h('div', { className: 'ff-muted' }, t('rounds', { a: Math.min(goal.roundsStarted || 0, goal.maxGoalRounds), b: goal.maxGoalRounds }))
              : null,
          )
          : null

        const todoBlock = h('div', { key: 'todo', className: 'ff-sec' },
          h('div', { className: 'ff-sec-h' }, `☑ ${t('todo')}`),
          todos.length === 0
            ? h('div', { className: 'ff-muted' }, t('todoNone'))
            : todos.slice(0, 12).map((todo, index) => h('div', {
              key: `todo-${index}`,
              className: `ff-todo ff-todo-${todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'in_progress' : 'pending'}`,
            },
              h('span', { className: 'ff-tick' }, todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'),
              h('span', { className: 'ff-todotext' }, oneLine(String(todo.content || ''), 90)),
            )),
          todos.length > 12 ? h('div', { className: 'ff-muted' }, t('more', { n: todos.length - 12 })) : null,
        )

        const jobBlock = jobs.length > 0
          ? h('div', { key: 'jobs', className: 'ff-sec' },
            h('div', { className: 'ff-sec-h' }, `⚙ ${t('jobs')}`),
            jobs.slice(0, 6).map((job, index) => h('div', { key: `job-${index}`, className: 'ff-job' },
              h('span', { className: `ff-job-st ff-job-${String(job.status || '')}` }, t(jobKey(job.status))),
              h('span', { className: 'ff-job-lbl' }, oneLine(String(job.label || job.id || ''), 42)),
              job.progress ? h('span', { className: 'ff-muted' }, oneLine(String(job.progress), 18)) : null,
            )),
          )
          : null

        const teamBlock = teamTasks !== null && teamTasks.length > 0
          ? h('div', { key: 'team', className: 'ff-sec' },
            h('div', { className: 'ff-sec-h' }, `👥 ${t('team')}`),
            teamTasks.slice(0, 8).map((task, index) => h('div', {
              key: `team-${index}`,
              className: `ff-todo ff-todo-${task.status === 'completed' ? 'completed' : task.status === 'in_progress' ? 'in_progress' : 'pending'}`,
            },
              h('span', { className: 'ff-tick' }, task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◐' : '○'),
              h('span', { className: 'ff-todotext' }, oneLine(String(task.subject || task.id || ''), 80)),
            )),
          )
          : null

        const othersLine = otherRunning > 0
          ? h('div', { key: 'others', className: 'ff-sec' },
            h('div', { className: 'ff-muted' }, t('others', { n: otherRunning })),
          )
          : null

        const panel = mode === 'expanded'
          ? h('div', { key: 'panel', className: 'ff-panel', role: 'dialog', 'aria-label': t('title') },
            h('div', { className: 'ff-head' },
              h('span', { className: 'ff-title', title }, title),
              h('span', { className: `ff-pill ${phaseClass(activePhase)}` }, statusText),
              h('button', {
                type: 'button',
                className: 'ff-xbtn',
                onClick: () => setMode('collapsed'),
                title: t('collapse'),
                'aria-label': t('collapse'),
              }, '×'),
            ),
            h('div', { className: 'ff-body' },
              progressBlock,
              currentRow,
              goalBlock,
              todoBlock,
              jobBlock,
              teamBlock,
              othersLine,
              data === null
                ? h('div', { className: 'ff-sec' }, h('div', { className: 'ff-muted' }, t('noTaskHint')))
                : active === null
                  ? h('div', { className: 'ff-sec' }, h('div', { className: 'ff-muted' }, t('noTask')))
                  : null,
            ),
            h('div', { className: 'ff-foot' },
              h('button', { type: 'button', className: 'ff-btn', onClick: cycleSize, title: t('size') }, `${Math.round(SIZES[sizeIndex] * 100)}%`),
              h('button', { type: 'button', className: 'ff-btn', onClick: () => setReload((n) => n + 1), title: t('refresh') }, '↻'),
              h('button', { type: 'button', className: 'ff-btn', onClick: resetPos, title: t('reset') }, '⌖'),
              h('span', { className: 'ff-spacer' }),
              h('button', { type: 'button', className: 'ff-btn', onClick: () => setMode('minimized'), title: t('minimize') }, '—'),
            ),
          )
          : null

        const minimizedTab = h('button', {
          key: 'tab',
          type: 'button',
          className: 'ff-tab',
          onClick: () => setMode('expanded'),
          title: t('tabHint'),
          'aria-label': t('restore'),
        }, h('img', { src: FISH_SRC, alt: '', draggable: false }))

        /* `dsh-whale-widget` (if installed) owns the very bottom-right corner, so
         * the un-dragged fish floats just above that corner; dragging overrides
         * this with saved viewport coordinates. */
        const rootStyle = pos === null ? { right: '20px', bottom: '176px' } : { left: `${pos.x}px`, top: `${pos.y}px` }

        return h('div', {
          key: 'root',
          ref: rootRef,
          className: `ff-root ${mode === 'expanded' ? 'ff-root-open' : ''}`,
          style: rootStyle,
          'data-fat-fish': 'widget',
        },
          styleTag,
          mode === 'minimized' ? minimizedTab : null,
          mode === 'expanded' ? panel : null,
          mode === 'minimized' ? null : h('div', { key: 'fishwrap', className: 'ff-fishwrap' }, bubble, mascot),
        )
      }
    }

    /* ------------------------------------------------------------------ apply */

    function apply(ctx) {
      let locale
      try {
        locale = ctx.get('locale')
      } catch (error) {
        locale = undefined
      }
      const Widget = createWidget(locale)
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'fat-fish-progress', order: 35 },
        Widget,
      ))
    }

    return { inject: ['slots'], apply }
  },
})
