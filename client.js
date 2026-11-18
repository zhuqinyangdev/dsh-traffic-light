window.__ModuleLoader__.load({
  id: 'dsh-traffic-light',
  factory(require) {
    const React = require('react')
    const POLL_MS = 1000
    const STORE_KEY = 'dsh-traffic-light:ui'

    const COLORS = {
      'red-blink': '#F85149',
      red: '#F85149',
      orange: '#F0883E',
      yellow: '#D29922',
      green: '#3FB950',
      grey: '#6E7681',
    }

    /* Lamps get their colour either as a state token ("green", "red-blink") or already
       resolved as a hex string, depending on the caller. Resolving both here keeps a
       hex-passing caller from silently rendering a grey lamp. */
    function paint(color) {
      if (typeof color !== 'string' || color === '') return COLORS.grey
      if (COLORS[color]) return COLORS[color]
      if (color.charAt(0) === '#') return color
      return COLORS.grey
    }

    const GROUPS = [
      { key: 'waiting', title: '等你处理' },
      { key: 'error', title: '出错' },
      { key: 'anomaly', title: '异常' },
      { key: 'running', title: '运行中' },
      { key: 'done', title: '刚完成' },
    ]

    function loadUi() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          return {
            open: Boolean(parsed?.open),
            right: Number.isFinite(parsed?.right) ? parsed.right : 16,
            bottom: Number.isFinite(parsed?.bottom) ? parsed.bottom : 96,
          }
        }
      } catch {
        /* storage may be unavailable */
      }
      return { open: false, right: 16, bottom: 96 }
    }

    function saveUi(ui) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(ui))
      } catch {
        /* ignore */
      }
    }

    function elapsed(ms) {
      const total = Math.max(0, Math.round(Number(ms) || 0))
      const seconds = Math.floor(total / 1000)
      if (seconds < 60) return `${seconds}秒`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}分${seconds % 60}秒`
      return `${Math.floor(minutes / 60)}小时${minutes % 60}分`
    }

    // Collapsed-capsule summary. All three numbers are always on screen — running / finished
    // (unread) / need-your-confirmation — but a number only gets its own lamp when it is
    // above zero: a blinking green lamp for finished, a blinking red one for confirmation.
    // Errors and anomalies are appended only when they exist, each with a lamp.
    function capsuleParts(summary) {
      const running = summary.running || 0
      const unread = summary.unread || 0
      const waiting = summary.waiting || 0
      const error = summary.error || 0
      const anomaly = summary.anomaly || 0
      return [
        { key: 'running', text: `${running} 运行中`, color: COLORS.yellow, lamp: false },
        { key: 'done', text: `${unread} 已完成`, color: COLORS.green, pulse: true, lamp: unread > 0 },
        { key: 'waiting', text: `${waiting} 需确认`, color: COLORS.red, pulse: true, lamp: waiting > 0 },
        error > 0
          ? { key: 'error', text: `${error} 出错`, color: COLORS.red, pulse: true, lamp: true }
          : null,
        anomaly > 0
          ? { key: 'anomaly', text: `${anomaly} 异常`, color: COLORS.orange, lamp: true }
          : null,
      ].filter(Boolean)
    }
    function pulseOf(entry) {
      if (entry.color === 'red-blink') return true
      if (entry.color === 'green' && entry.unread) return true
      return false
    }

    function rowMeta(entry, now) {
      if (entry.color === 'red-blink') {
        const kind = entry.waiting?.kind
        if (kind === 'question') return { text: '需要您确认', color: COLORS.red }
        if (kind === 'plan') return { text: '计划待批准', color: COLORS.red }
        if (kind === 'approval') return { text: '等待批准', color: COLORS.red }
        const since = Number(entry.waiting?.since)
        return {
          text: Number.isFinite(since) ? `已等 ${elapsed(now - since)}` : '等待',
          color: COLORS.red,
        }
      }
      if (entry.state === 'error') return { text: '出错', color: COLORS.red }
      if (entry.state === 'anomaly') return { text: `异常 · ${entry.warning || '会话异常'}`, color: COLORS.orange }
      if (entry.color === 'yellow') return { text: `${entry.exactStart === false ? '≈' : ''}用时 ${elapsed(entry.elapsedMs)}`, color: COLORS.yellow }
      if (entry.state === 'done') return { text: '', color: '#8B949E' }
      return { text: entry.endedReason ? String(entry.endedReason) : '', color: '#8B949E' }
    }

    let appCtx = null

    const report = (kind, message, sessionId) => {
      try {
        fetch('/api/traffic-light/state/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, message, sessionId: sessionId ?? null }),
        }).catch(() => {})
      } catch {
        /* diagnostics only */
      }
    }

    /* `uiWorkspace.openSession` synchronously swaps the main view reference; the target may be
       any known Session id. A stale in-flight navigation can still commit later, so begin a
       fresh navigation first to abort whatever the app had pending. */
    const openInWorkspace = (id) => {
      const workspace = appCtx?.get?.('uiWorkspace')
      if (!workspace) {
        report('focus-no-workspace', 'uiWorkspace service missing', id)
        return false
      }
      if (typeof workspace.openSession !== 'function') {
        report('focus-no-open', `openSession unavailable; keys=${Object.keys(workspace).join(',')}`, id)
        return false
      }
      const before = document.title
      const attempt = (label) => {
        try {
          appCtx?.get?.('layout')?.beginNavigation?.()
        } catch {
          /* layout is optional here */
        }
        try {
          workspace.openSession(String(id))
          report(label, `title=${document.title}`, id)
          return true
        } catch (error) {
          report('focus-open-error', String((error && (error.stack || error.message)) || error).slice(0, 300), id)
          return false
        }
      }
      if (!attempt('focus-open-ok')) return false
      /* The app may put the Session that owns an unsent composer draft back into the main view.
         Re-assert exactly once, then yield: whoever is actively editing should win. */
      setTimeout(() => {
        if (document.title !== before) return
        const current = appCtx?.get?.('uiWorkspace')
        if (!current || typeof current.openSession !== 'function') return
        try {
          current.openSession(String(id))
          report('focus-retry', `title=${document.title}`, id)
        } catch {
          /* the session may have been archived meanwhile */
        }
      }, 1200)
      return true
    }

    function Dot({ color, pulse, size }) {
      const [bright, setBright] = React.useState(true)
      React.useEffect(() => {
        if (!pulse) {
          setBright(true)
          return undefined
        }
        const timer = setInterval(() => setBright((current) => !current), 700)
        return () => clearInterval(timer)
      }, [pulse])
      const base = size ?? 12
      const fill = paint(color)
      /* Breathing must not look like "the lamp went grey": fading the fill towards the dark
         capsule washes a small dot out to grey, so the pulse spends its contrast on the glow
         ring and a slight swell instead, and the colour itself stays fully saturated. */
      return React.createElement('span', {
        style: {
          display: 'inline-block',
          width: base,
          height: base,
          borderRadius: '50%',
          flex: '0 0 auto',
          background: fill,
          opacity: pulse && !bright ? 0.92 : 1,
          transform: pulse && !bright ? 'scale(0.82)' : 'scale(1)',
          boxShadow: pulse
            ? bright
              ? `0 0 2px ${fill}, 0 0 7px ${fill}`
              : `0 0 1px ${fill}`
            : 'none',
          transition: 'transform 320ms ease-in-out, box-shadow 320ms ease-in-out',
        },
      })
    }

    function Tile({ entry, now, onClick, showDot = true }) {
      const meta = rowMeta(entry, now)
      return React.createElement(
        'button',
        {
          type: 'button',
          onClick,
          title: entry.title
            ? [
                entry.title,
                `工作区：${entry.workspace || '（未关联）'}`,
                entry.waiting?.kind === 'plan' && entry.waiting.reason
                  ? `计划待批准：${entry.waiting.reason}`
                  : null,
                entry.cwd ?? '',
              ]
                .filter(Boolean)
                .join('\n')
            : entry.cwd ?? entry.id,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 8px',
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            textAlign: 'left',
            font: 'inherit',
          },
          onMouseEnter: (event) => {
            event.currentTarget.style.background = 'var(--dsw-alias-bg-hover, rgba(255,255,255,.06))'
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.background = 'transparent'
          },
        },
        React.createElement(
          'span',
          {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: entry.unread ? 600 : 400,
            },
          },
          entry.label,
          entry.children
            ? React.createElement(
                'span',
                { style: { marginLeft: 4, opacity: 0.65, fontSize: 11 } },
                `ˣ${entry.children}`,
              )
            : null,
        ),
        React.createElement(
          'span',
          {
            style: {
              flex: '0 0 auto',
              fontSize: 11,
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              color: meta.color,
            },
          },
          meta.text,
        ),
        showDot === false
          ? null
          : React.createElement(Dot, { color: entry.color, pulse: pulseOf(entry), size: 12 }),
      )
    }

    function TrafficLight() {
      const initial = React.useMemo(loadUi, [])
      const [ui, setUi] = React.useState(initial)
      const [state, setState] = React.useState(null)
      const [offline, setOffline] = React.useState(false)
      const dragRef = React.useRef(null)
      const focusedRef = React.useRef(new Set())

      const applyUi = (draft) => {
        saveUi(draft)
        setUi(draft)
      }

      const openSession = (entry) => {
        openInWorkspace(entry.id)
        fetch('/api/traffic-light/state/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: entry.id }),
        }).catch(() => {})
        applyUi({ ...ui, open: false })
      }

      const acknowledgeFocus = (ids) => {
        if (!ids.length) return
        fetch('/api/traffic-light/state/focus/ack', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids }),
        }).catch(() => {})
      }

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          fetch('/api/traffic-light/state', { headers: { accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
            .then((json) => {
              if (!alive) return
              setState(json)
              setOffline(false)
              const focus = Array.isArray(json?.focus) ? json.focus : []
              const fresh = focus.filter((entry) => entry?.id && !focusedRef.current.has(`${entry.id}:${entry.at}`))
              if (fresh.length) {
                for (const entry of fresh) focusedRef.current.add(`${entry.id}:${entry.at}`)
                openInWorkspace(fresh[0].id)
                acknowledgeFocus(fresh.map((entry) => String(entry.id)))
              }
            })
            .catch(() => {
              if (alive) setOffline(true)
            })
        }
        tick()
        report('client-boot', 'v6', null)
        const timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      React.useEffect(() => {
        if (!ui.open) return undefined
        const close = () => applyUi({ ...ui, open: false })
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        // Click anywhere that is not the capsule/panel closes the popup. The overlay slot is
        // frame-wide, so this also covers clicks in the conversation and sidebars.
        const onDown = (event) => {
          const target = event.target
          if (target && typeof target.closest === 'function' && target.closest('[data-traffic-light-root]')) return
          close()
        }
        window.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onDown, true)
        return () => {
          window.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onDown, true)
        }
      }, [ui])

      const sessions = Array.isArray(state?.sessions) ? state.sessions : []
      const now = Number(state?.now) || Date.now()
      const summary = state?.summary ?? { running: 0, waiting: 0, error: 0, done: 0, unread: 0, idle: 0, total: 0 }
      const budget = Math.max(1, Number(state?.maxLights) || 6)

      const buckets = {
        waiting: [],
        error: [],
        anomaly: [],
        running: [],
        done: [],
      }
      for (const entry of sessions) {
        if (entry.color === 'red-blink') buckets.waiting.push(entry)
        else if (entry.state === 'error') buckets.error.push(entry)
        else if (entry.state === 'anomaly') { if (entry.color !== 'grey') buckets.anomaly.push(entry) }
        else if (entry.color === 'yellow') buckets.running.push(entry)
        else if (entry.state === 'done') buckets.done.push(entry)
      }

      const rows = []
      let used = 0
      let hidden = 0

      /* A plain "what did I touch last" list: newest first, no filtering by state, so the
         session you are talking to right now is always the first row. Sessions already
         listed in the status groups below may therefore appear twice — that is intended,
         the groups answer "what needs me", this list answers "where was I". The count is a
         plugin config value (`recentCount`, default 5); 0 removes the section. */
      const RECENT_LIMIT = (() => {
        const raw = state?.recentCount
        const parsed = raw == null ? 5 : Number(raw)
        if (!Number.isFinite(parsed)) return 5
        return Math.min(50, Math.max(0, Math.trunc(parsed)))
      })()
      const recent = RECENT_LIMIT > 0
        ? sessions
            .filter((entry) => (Number(entry.recentAt) || 0) > 0)
            .sort((a, b) => (Number(b.recentAt) || 0) - (Number(a.recentAt) || 0))
            .slice(0, RECENT_LIMIT)
        : []
      if (recent.length > 0) {
        rows.push(
          React.createElement(
            'div',
            {
              key: 'head-recent',
              style: { padding: '6px 8px 2px', fontSize: 11, opacity: 0.6, letterSpacing: '.04em' },
            },
            `最近的会话 · ${recent.length}`,
          ),
        )
        for (const entry of recent) {
          rows.push(
            React.createElement(Tile, {
              key: `recent-${entry.id}`,
              entry,
              now,
              showDot: false,
              onClick: () => openSession(entry),
            }),
          )
        }
      }
      for (const group of GROUPS) {
        const items = buckets[group.key]
        if (!items.length) continue
        const room = Math.max(0, budget - used)
        const shown = items.slice(0, room)
        used += shown.length
        hidden += items.length - shown.length
        if (!shown.length) continue
        rows.push(
          React.createElement(
            'div',
            {
              key: `head-${group.key}`,
              style: { padding: '6px 8px 2px', fontSize: 11, opacity: 0.6, letterSpacing: '.04em' },
            },
            `${group.title} · ${items.length}`,
          ),
        )
        for (const entry of shown) {
          rows.push(React.createElement(Tile, { key: entry.id, entry, now, onClick: () => openSession(entry) }))
        }
      }

      const headMetaParts = []
      if (summary.running > 0) headMetaParts.push(`跑 ${summary.running}`)
      if (summary.anomaly > 0) headMetaParts.push(`异 ${summary.anomaly}`)
      if (summary.idle > 0) headMetaParts.push(`空闲 ${summary.idle}`)
      if (hidden > 0) headMetaParts.push(`另有 ${hidden} 条`)
      const headMeta = headMetaParts.join(' · ')

      /* The leading lamp answers one question: "is anything happening right now?".
         Finished-but-unread work is NOT happening — it already owns its own green lamp
         inside the capsule — so a green head next to "0 运行中" would be a contradiction. */
      const headDotColor = summary.waiting > 0
        ? 'red-blink'
        : summary.error > 0
          ? 'red'
          : summary.anomaly > 0
            ? 'orange'
            : summary.running > 0
              ? 'yellow'
              : 'grey'

      const capsule = React.createElement(
        'div',
        {
          onPointerDown: (event) => {
            const box = event.currentTarget.getBoundingClientRect()
            dragRef.current = {
              startX: event.clientX,
              startY: event.clientY,
              right: window.innerWidth - box.right,
              bottom: window.innerHeight - box.bottom,
              moved: false,
            }
            try {
              event.currentTarget.setPointerCapture(event.pointerId)
            } catch {
              /* ignore */
            }
          },
          onPointerMove: (event) => {
            const drag = dragRef.current
            if (!drag) return
            const dx = event.clientX - drag.startX
            const dy = event.clientY - drag.startY
            if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
            drag.moved = true
            applyUi({
              ...ui,
              right: Math.max(8, Math.min(window.innerWidth - 60, drag.right - dx)),
              bottom: Math.max(8, Math.min(window.innerHeight - 40, drag.bottom - dy)),
            })
          },
          onPointerUp: (event) => {
            const drag = dragRef.current
            dragRef.current = null
            try {
              event.currentTarget.releasePointerCapture(event.pointerId)
            } catch {
              /* ignore */
            }
            if (drag && !drag.moved) applyUi({ ...ui, open: !ui.open })
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            borderRadius: 999,
            cursor: 'pointer',
            background: 'var(--dsw-alias-bg-popover, rgba(24,26,32,.92))',
            border: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.12))',
            boxShadow: '0 6px 20px rgba(0,0,0,.35)',
            backdropFilter: 'blur(10px)',
            color: 'var(--dsw-alias-text-primary, #E6E8EB)',
            fontSize: 12,
          },
        },
        React.createElement(Dot, {
          color: headDotColor,
          /* Only a live Turn or a pending question is worth pulsing. Finished work already
             pulses on its own lamp inside the capsule, so a still green head lamp would
             just be a second, redundant blink. */
          pulse: summary.waiting > 0 || summary.running > 0,
        }),
        offline
          ? React.createElement('span', null, '红绿灯离线')
          : capsuleParts(summary).length === 0
            ? React.createElement('span', null, '全部空闲')
            : React.createElement(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' } },
                capsuleParts(summary).flatMap((part, index) => {
                  const node = React.createElement(
                    'span',
                    { key: part.key, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                    part.lamp
                      ? React.createElement(Dot, { color: part.color, pulse: part.pulse, size: 12 })
                      : null,
                    React.createElement('span', null, part.text),
                  )
                  if (index === 0) return [node]
                  return [
                    React.createElement(
                      'span',
                      { key: `${part.key}-sep`, style: { opacity: 0.45 } },
                      '·',
                    ),
                    node,
                  ]
                }),
              ),
      )

      const panel = React.createElement(
        'div',
        {
          style: {
            position: 'absolute',
            right: 0,
            bottom: 'calc(100% + 8px)',
            width: 320,
            maxHeight: 380,
            overflowY: 'auto',
            borderRadius: 12,
            padding: 6,
            background: 'var(--dsw-alias-bg-popover, rgba(24,26,32,.96))',
            border: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.12))',
            boxShadow: '0 12px 32px rgba(0,0,0,.42)',
            backdropFilter: 'blur(12px)',
            color: 'var(--dsw-alias-text-primary, #E6E8EB)',
            fontSize: 12.5,
          },
        },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '4px 8px 6px',
              fontWeight: 600,
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            React.createElement('span', null, '会话红绿灯'),
            headMeta
              ? React.createElement(
                  'span',
                  { style: { fontSize: 11, fontWeight: 400, opacity: 0.6, letterSpacing: '.02em' } },
                  headMeta,
                )
              : null,
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: (event) => {
                event.stopPropagation()
                fetch('/api/traffic-light/state/read', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ all: true }),
                }).catch(() => {})
              },
              style: {
                border: 'none',
                background: 'transparent',
                color: 'var(--dsw-alias-accent-primary, #4C9AFF)',
                cursor: 'pointer',
                fontSize: 11.5,
                padding: 0,
              },
            },
            '全部已读',
          ),
        ),
        ...(rows.length
          ? rows
          : [React.createElement('div', { key: 'empty', style: { padding: '10px 8px', opacity: 0.6 } }, '全部空闲')]),
      )

      /* The remembered spot is a pixel offset from the bottom-right corner. Shrink the window
         and the same offset lands outside the viewport — which looks exactly like "the capsule
         only shows up when the window is maximised". The poll re-renders once a second, so
         clamping against the live viewport is enough; the stored value stays untouched so the
         capsule returns to its old spot when the window grows back. */
      const viewW = typeof window === 'undefined' ? 1280 : window.innerWidth
      const viewH = typeof window === 'undefined' ? 800 : window.innerHeight
      const safeRight = Math.max(8, Math.min(Math.max(8, viewW - 72), ui.right))
      const safeBottom = Math.max(8, Math.min(Math.max(8, viewH - 56), ui.bottom))

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            right: safeRight,
            bottom: safeBottom,
            zIndex: 60,
            pointerEvents: 'auto',
            fontFamily: 'var(--dsw-font-family, "Microsoft YaHei UI", system-ui, sans-serif)',
            userSelect: 'none',
          },
          'data-traffic-light-root': '1',
        },
        ui.open ? panel : null,
        capsule,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        appCtx = ctx
        ctx.effect(() =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register({ name: 'shell.overlay', id: 'traffic-light', order: 400 }, TrafficLight),
          ),
        )
      },
    }
  },
})
