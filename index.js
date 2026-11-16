import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const STATE = Object.freeze({
  RUNNING: 'running',
  WAITING: 'waiting',
  ERROR: 'error',
  DONE: 'done',
  IDLE: 'idle',
})

/* Tools that block on a human answer; used as a fallback when the
   `user-questions/request` event arrives without an agent reference. */
const QUESTION_TOOLS = new Set(['ask_user_question', 'askuserquestion', 'user_question'])

const DEFAULTS = Object.freeze({
  maxLights: 6,
  titleTtlMs: 60_000,
  endpoint: '/api/traffic-light/state',
  reconcileMs: 10_000,
  staleIdleMs: 30 * 60_000,
  maxEntries: 60,
  sortOrder: 'asc',
  desktopWindow: Object.freeze({
    enabled: true,
    refreshMs: 1000,
    opacity: 1,
    width: 300,
    focusApp: true,
  }),
})

const nowMs = () => Date.now()

const shortId = (id) => String(id ?? '').replace(/^session-/, '').slice(0, 4)

function workspaceName(cwd) {
  if (!cwd) return ''
  const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

function clip(value, max) {
  const chars = Array.from(String(value ?? ''))
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

function endedLabel(kind) {
  switch (kind) {
    case 'completed': return null
    case 'aborted':
    case 'interrupted': return '已停止'
    case 'max-tokens': return '达到长度上限'
    case 'forked': return '已分叉'
    case 'blocked': return '被拦截'
    case 'error': return null
    case 'stopped': return '已停止'
    default: return kind ? String(kind) : null
  }
}

function errorText(error) {  if (!error) return 'error'
  if (typeof error === 'string') return clip(error, 80)
  const message = error.message ?? error.code ?? error.reason
  return clip(typeof message === 'string' && message ? message : String(error), 80)
}

class ReadStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'read-state.json')
    this.sessions = new Map()
    this.timer = null
    this.load()
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const [id, at] of Object.entries(raw?.sessions ?? {})) {
        if (typeof at === 'number') this.sessions.set(id, at)
      }
    } catch {
      /* first run: no state yet */
    }
  }

  readAt(id) {
    return this.sessions.get(id) ?? 0
  }

  mark(id, at = nowMs()) {
    this.sessions.set(id, at)
    this.schedule()
  }

  markAll(ids, at = nowMs()) {
    for (const id of ids) this.sessions.set(id, at)
    this.schedule()
  }

  schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      try {
        mkdirSync(this.dir, { recursive: true })
        writeFileSync(this.file, JSON.stringify({ version: 1, sessions: Object.fromEntries(this.sessions) }))
      } catch {
        /* best effort: read state is a convenience, not a truth source */
      }
    }, 250)
  }

  dispose() {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

function dataDir() {
  const base = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME
  return base ? join(base, '.traffic-light') : join(tmpdir(), 'dsh-traffic-light')
}

export const inject = ['webServer']

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const windowConfig = { ...DEFAULTS.desktopWindow, ...((rawConfig ?? {}).desktopWindow ?? {}) }
  const lights = new Map()
  const titles = new Map()
  const titleInflight = new Set()
  const questionCalls = new Map()
  const idleTimers = new Map()
  const focusRequests = []
  const clientReports = []
  const readStore = new ReadStore(dataDir())
  const startedAt = nowMs()
  const companion = { handle: null, launched: false, attempts: 0, lastExit: null, error: null }
  const focusLog = []

  const logFocus = (stage, message = null) => {
    focusLog.push({ at: nowMs(), stage, message })
    while (focusLog.length > 8) focusLog.shift()
  }

  ctx.effect(() => () => readStore.dispose())

  const lightFor = (sessionId) => {
    const id = String(sessionId ?? '')
    if (!id) return undefined
    let light = lights.get(id)
    if (!light) {
      const at = nowMs()
      light = {
        sessionId: id,
        title: '',
        cwd: '',
        origin: undefined,
        parentSessionId: undefined,
        blank: false,
        state: STATE.IDLE,
        stateSince: at,
        running: false,
        turn: null,
        step: null,
        tool: null,
        toolSince: null,
        waiting: null,
        error: null,
        startedAt: null,
        startedAtExact: false,
        completedAt: null,
        lastActivityAt: at,
        endedReason: null,
      }
      lights.set(id, light)
    }
    return light
  }

  const setState = (light, state) => {
    if (!light || light.state === state) return
    light.state = state
    light.stateSince = nowMs()
  }

  const refreshTitle = (light) => {
    if (!light) return
    const cached = titles.get(light.sessionId)
    if (cached && nowMs() - cached.at < config.titleTtlMs) {
      light.title = cached.title
      return
    }
    if (titleInflight.has(light.sessionId)) return
    const query = ctx.get('sessionQuery')
    if (typeof query?.readTitle !== 'function') return
    titleInflight.add(light.sessionId)
    Promise.resolve(query.readTitle(light.sessionId))
      .then((snapshot) => {
        const title = typeof snapshot?.title === 'string' ? snapshot.title.trim() : ''
        if (!title) return
        titles.set(light.sessionId, { title, at: nowMs() })
        const current = lights.get(light.sessionId)
        if (current) current.title = title
      })
      .catch(() => {})
      .finally(() => titleInflight.delete(light.sessionId))
  }

  const colorOf = (light, unread) => {
    if (light.waiting) return 'red-blink'
    if (light.state === STATE.ERROR) return 'red'
    if (light.state === STATE.RUNNING) return 'yellow'
    if (light.state === STATE.DONE) return unread ? 'green' : 'grey'
    return 'grey'
  }

  /* ---------------------------------------------------------------- events */

  ctx.on('api-session/added', (summary) => {
    if (!summary?.sessionId) return
    const light = lightFor(summary.sessionId)
    if (summary.cwd) light.cwd = summary.cwd
    light.origin = summary.origin ?? light.origin
    light.parentSessionId = summary.parentSessionId ?? light.parentSessionId
    light.blank = Boolean(summary.blank)
    light.running = Boolean(summary.running)
    if (typeof summary.updatedAt === 'number') light.lastActivityAt = Math.max(light.lastActivityAt, summary.updatedAt)
    const projected = summary.projections?.values?.title
    if (typeof projected === 'string' && projected.trim()) {
      light.title = projected.trim()
      titles.set(light.sessionId, { title: light.title, at: nowMs() })
    } else {
      refreshTitle(light)
    }
    if (light.running && (light.state === STATE.IDLE || light.state === STATE.DONE)) {
      if (light.completedAt != null || light.startedAt == null) {
        light.startedAt = nowMs()
        light.startedAtExact = false
      }
      light.completedAt = null
      if (!light.waiting) setState(light, STATE.RUNNING)
    }
  })

  ctx.on('api-session/status', (sessionId, running) => {
    if (!sessionId) return
    const light = lightFor(sessionId)
    light.running = Boolean(running)
    light.lastActivityAt = nowMs()
    if (running) {
      light.error = null
      light.tool = null
      light.toolSince = null
      /* A new Turn that we did not see start (plugin loaded late, or the event bridge dropped
         it) begins a fresh clock only when the previous Turn is known to have ended. */
      if (light.completedAt != null || light.startedAt == null) {
        light.startedAt = nowMs()
        light.startedAtExact = false
      }
      light.completedAt = null
      if (!light.waiting) setState(light, STATE.RUNNING)
      refreshTitle(light)
      return
    }
    if (light.state === STATE.RUNNING || light.state === STATE.WAITING || light.waiting) {
      /* A stop from the UI does not always end the Turn with a `turn/end` event, so the
         running flag dropping is the reliable "it stopped" signal. A dismissed question
         also leaves no `tool/result`, hence the waiting flag is dropped here too. */
      clearWaiting(light)
      light.completedAt = nowMs()
      if (!light.endedReason) light.endedReason = endedLabel('stopped')
      setState(light, light.error ? STATE.ERROR : STATE.IDLE)
    }
  })

  ctx.on('agent/status', (payload) => {
    const id = payload?.agent?.id
    if (!id) return
    const light = lights.get(String(id))
    if (!light) return
    const status = payload?.status
    if (status === 'running') {
      light.running = true
      if (!light.waiting && light.state !== STATE.RUNNING) {
        light.error = null
        setState(light, STATE.RUNNING)
      }
      return
    }
    if (status !== 'idle') return
    light.running = false
    if (light.state !== STATE.RUNNING || light.waiting) return
    /* `agent/status` can flip to idle between steps, so wait for a quiet gap before
       declaring the Turn stopped - a follow-up event cancels this. */
    const stamp = light.lastActivityAt
    const key = String(id)
    const pending = idleTimers.get(key)
    if (pending) clearTimeout(pending)
    idleTimers.set(
      key,
      setTimeout(() => {
        idleTimers.delete(key)
        if (light.state !== STATE.RUNNING || light.waiting) return
        if (light.lastActivityAt > stamp) return
        light.completedAt = nowMs()
        if (!light.endedReason) light.endedReason = endedLabel('stopped')
        light.tool = null
        light.toolSince = null
        setState(light, light.error ? STATE.ERROR : STATE.IDLE)
      }, 1500),
    )
  })

  ctx.on('api-session/removed', (sessionId) => {
    if (!sessionId) return
    lights.delete(String(sessionId))
  })

  ctx.on('api-session/error', (sessionId, message) => {
    if (!sessionId) return
    const light = lightFor(sessionId)
    light.error = clip(message || 'error', 80)
    setState(light, STATE.ERROR)
  })

  ctx.on('api-session/activity', (sessionId, updatedAt) => {
    if (!sessionId) return
    const light = lightFor(sessionId)
    if (typeof updatedAt === 'number') light.lastActivityAt = Math.max(light.lastActivityAt, updatedAt)
  })

  ctx.on('session/event', (session, event) => {
    const id = session?.id ?? session?.header?.id
    if (!id || !event) return
    const light = lightFor(id)
    const data = event.data ?? {}
    light.lastActivityAt = nowMs()
    if (!light.cwd && session?.header?.cwd) light.cwd = session.header.cwd
    if (!light.parentSessionId && session?.header?.parentSession) light.parentSessionId = session.header.parentSession

    /* A dismissed question emits no `tool/result`, so the fallback waiting state would
       stick forever. A model reply or any *other* tool call proves the question is gone. */
    if (light.waiting?.kind === 'question' && light.waiting.tool) {
      const isQuestionCall =
        event.type === 'tool/call' && QUESTION_TOOLS.has(String(data.name ?? '').toLowerCase())
      if (event.type === 'assistant/message' || (event.type === 'tool/call' && !isQuestionCall)) {
        clearWaiting(light)
        if (light.state === STATE.WAITING) setState(light, light.running ? STATE.RUNNING : STATE.IDLE)
      }
    }

    switch (event.type) {
      case 'turn/start':
        /* a fresh Turn means whatever was pending belongs to a finished Turn */
        clearWaiting(light)
        light.running = true
        light.turn = data.turn ?? light.turn
        light.step = null
        light.tool = null
        light.toolSince = null
        light.error = null
        light.endedReason = null
        /* The app clocks a running Turn from `turn.start.time`, so the light has to do the
           same: every Turn resets the clock, otherwise "已跑" drifts into session age. */
        light.startedAt = typeof event.time === 'number' ? event.time : nowMs()
        light.startedAtExact = typeof event.time === 'number'
        light.completedAt = null
        setState(light, STATE.RUNNING)
        refreshTitle(light)
        break
      case 'tool/call':
        light.running = true
        light.tool = data.name ?? null
        light.toolSince = nowMs()
        /* `user-questions/request` sometimes arrives without an `agent`, so the waiting
           lamp has to be derived from the tool call as well. */
        if (QUESTION_TOOLS.has(String(data.name ?? '').toLowerCase()) && data.callId) {
          questionCalls.set(String(data.callId), id)
          waitingOn(light, {
            kind: 'question',
            since: typeof event.time === 'number' ? event.time : nowMs(),
            tool: data.name ?? null,
            reason: null,
          })
        }
        light.step = data.step ?? light.step
        light.turn = data.turn ?? light.turn
        light.error = null
        light.completedAt = null
        if (light.startedAt == null) {
          light.startedAt = nowMs()
          light.startedAtExact = false
        }
        if (!light.waiting) setState(light, STATE.RUNNING)
        break
      case 'assistant/message':
        if (light.startedAt == null) {
          light.startedAt = nowMs()
          light.startedAtExact = false
        }
        light.completedAt = null
        if (!light.waiting) setState(light, STATE.RUNNING)
        break
      case 'tool/result': {
        light.tool = null
        light.toolSince = null
        const callId = data.callId ? String(data.callId) : null
        if (callId && questionCalls.get(callId) === id) {
          questionCalls.delete(callId)
          if (light.waiting?.kind === 'question' && light.waiting.tool) waitingOff(light)
        }
        break
      }
      case 'turn/end': {
        const reason = data.reason ?? {}
        /* the Turn is over: a pending question/approval can no longer be answered */
        clearWaiting(light)
        light.endedReason = endedLabel(reason.kind)
        light.running = false
        light.tool = null
        light.toolSince = null
        const endedAt = typeof event.time === 'number' ? event.time : nowMs()
        if (reason.kind === 'completed') {
          light.completedAt = endedAt
          if (!light.waiting) setState(light, STATE.DONE)
        } else if (reason.kind === 'error') {
          light.completedAt = endedAt
          light.error = errorText(reason.error)
          setState(light, STATE.ERROR)
        } else if (reason.kind === 'blocked') {
          light.completedAt = endedAt
          light.error = 'blocked'
          setState(light, STATE.ERROR)
        } else {
          light.completedAt = endedAt
          setState(light, STATE.IDLE)
        }
        break
      }
      default:
        break
    }
  })

  ctx.on('agent/error', (payload) => {
    const id = payload?.agent?.id
    if (!id) return
    const light = lightFor(id)
    light.error = errorText(payload.error)
    setState(light, STATE.ERROR)
  })

  /* -------------------------------------------------- waiting for a human */

  const waitingOn = (light, waiting) => {
    if (!light) return
    light.waiting = waiting
    light.stateSince = nowMs()
  }

  const clearWaiting = (light) => {
    if (!light) return
    light.waiting = null
    for (const [callId, owner] of questionCalls) {
      if (owner === light.sessionId) questionCalls.delete(callId)
    }
  }

  const waitingOff = (light) => {
    if (!light) return
    light.waiting = null
    if (light.state === STATE.RUNNING && !light.running) {
      setState(light, light.error ? STATE.ERROR : STATE.IDLE)
    }
  }

  ctx.on('approval/request', async (request, next) => {
    const light = lightFor(request?.agent?.id)
    waitingOn(light, {
      kind: 'approval',
      since: nowMs(),
      tool: request?.toolName ?? null,
      reason: clip(request?.displayReason?.zh ?? request?.displayReason?.en ?? request?.reason ?? '', 60),
    })
    try {
      return typeof next === 'function' ? await next() : 'cancelled'
    } finally {
      waitingOff(light)
    }
  })

  ctx.on('user-questions/request', async (request, next) => {
    const light = lightFor(request?.agent?.id)
    waitingOn(light, {
      kind: 'question',
      since: nowMs(),
      tool: null,
      reason: clip(request?.questions?.[0]?.header ?? request?.questions?.[0]?.question ?? '', 60),
    })
    try {
      return typeof next === 'function' ? await next() : { answers: [] }
    } finally {
      if (light) {
        clearWaiting(light)
        if (light.state === STATE.WAITING) setState(light, light.running ? STATE.RUNNING : STATE.IDLE)
      } else {
        /* the request carried no agent: clear every fallback question light, since the
           matching `tool/result` never arrives when the dialog is dismissed */
        for (const other of lights.values()) {
          if (other.waiting?.kind === 'question' && other.waiting.tool) {
            clearWaiting(other)
            if (other.state === STATE.WAITING) setState(other, other.running ? STATE.RUNNING : STATE.IDLE)
          }
        }
      }
    }
  })

  /* ------------------------------------------------------------- snapshots */

  const childrenOf = () => {
    const counts = new Map()
    for (const light of lights.values()) {
      if (!light.parentSessionId) continue
      if (!lights.has(light.parentSessionId)) continue
      counts.set(light.parentSessionId, (counts.get(light.parentSessionId) ?? 0) + 1)
    }
    return counts
  }

  const rankOf = (light) => {
    if (light.waiting) return 0
    if (light.state === STATE.ERROR) return 1
    if (light.state === STATE.RUNNING) return 2
    if (light.state === STATE.DONE) return 3
    return 4
  }

  const build = () => {
    const at = nowMs()
    const counts = childrenOf()
    const summary = { running: 0, waiting: 0, error: 0, done: 0, unread: 0, idle: 0, total: 0 }
    const sessions = []

    for (const light of lights.values()) {
      const readAt = readStore.readAt(light.sessionId)
      const unread = light.state === STATE.DONE && (light.completedAt ?? 0) > readAt
      const color = colorOf(light, unread)
      const children = counts.get(light.sessionId) ?? 0
      const isChild = Boolean(light.parentSessionId && lights.has(light.parentSessionId))

      if (!isChild) {
        if (light.waiting) summary.waiting += 1
        else if (light.state === STATE.ERROR) summary.error += 1
        else if (light.state === STATE.RUNNING) summary.running += 1
        else if (light.state === STATE.DONE) summary.done += 1
        else summary.idle += 1
        if (unread) summary.unread += 1
      }

      const workspace = workspaceName(light.cwd)
      const base = light.title || workspace || shortId(light.sessionId)
      /* No data-level truncation: both surfaces ellipsize to whatever width they
         actually have, so a wide card can show the whole title. */
      const label = workspace && light.title ? `${base} · ${workspace}` : base
      const elapsedMs = light.startedAt ? Math.max(0, (light.completedAt ?? at) - light.startedAt) : 0

      sessions.push({
        id: light.sessionId,
        short: shortId(light.sessionId),
        title: light.title,
        label,
        workspace,
        cwd: light.cwd,
        origin: light.origin ?? null,
        parentId: isChild ? light.parentSessionId : null,
        children,
        state: light.state,
        color,
        unread,
        waiting: light.waiting ? { kind: light.waiting.kind, since: light.waiting.since, tool: light.waiting.tool, reason: light.waiting.reason } : null,
        tool: light.tool,
        turn: light.turn,
        error: light.error,
        endedReason: light.endedReason,
        running: light.state === STATE.RUNNING,
        startedAt: light.startedAt,
        completedAt: light.completedAt,
        stateSince: light.stateSince,
        lastActivityAt: light.lastActivityAt,
        elapsedMs,
        /* false = the start time is an estimate (plugin just (re)loaded and has not
           seen this Turn's own turn/start yet). Surfaces render it with a ≈ prefix. */
        exactStart: light.running ? Boolean(light.startedAtExact) : true,
      })
    }

    summary.total = summary.running + summary.waiting + summary.error + summary.done + summary.idle

    const parents = sessions.filter((entry) => !entry.parentId)
    const order = config.sortOrder === 'desc' ? -1 : 1
    const ageOf = (entry) =>
      entry.waiting
        ? Math.max(0, at - (entry.waiting.since ?? at))
        : Math.max(0, entry.elapsedMs ?? 0)
    parents.sort((a, b) => {
      const rankA = rankOf({ waiting: a.waiting, state: a.state })
      const rankB = rankOf({ waiting: b.waiting, state: b.state })
      if (rankA !== rankB) return rankA - rankB
      const ageA = ageOf(a)
      const ageB = ageOf(b)
      if (ageA !== ageB) return order * (ageA - ageB)
      return String(a.label).localeCompare(String(b.label))
    })

    return {
      v: 1,
      pid: process.pid,
      now: at,
      startedAt,
      maxLights: config.maxLights,
      summary,
      sessions: parents.slice(0, config.maxEntries),
      focus: focusRequests.slice(0, 20),
      reports: clientReports.slice(-12),
      focusLog: focusLog.slice(-8),
      desktop: {
        enabled: windowConfig.enabled !== false,
        launched: companion.launched,
        running: Boolean(companion.handle),
        lastExit: companion.lastExit,
        error: companion.error,
      },
    }
  }

  /* ---------------------------------------------------------------- routes */

  const sendJson = (res, status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    res.end(payload)
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 64 * 1024) req.destroy()
      })
      req.on('end', () => resolve(raw))
      req.on('error', () => resolve(''))
    })

  const statePath = config.endpoint.startsWith('/') ? config.endpoint : `/${config.endpoint}`
  const readPath = `${statePath}/read`
  const focusPath = `${statePath}/focus`
  const ackPath = `${statePath}/focus/ack`
  const reportPath = `${statePath}/report`

  const jsonBody = async (req) => {
    try {
      const raw = await readBody(req)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: statePath,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          sendJson(res, 200, build())
        } catch (error) {
          sendJson(res, 500, { error: errorText(error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: readPath,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let body = {}
        try {
          const raw = await readBody(req)
          body = raw ? JSON.parse(raw) : {}
        } catch {
          body = {}
        }
        if (body?.all === true) {
          const ids = []
          for (const light of lights.values()) {
            if (light.state === STATE.DONE && !(light.parentSessionId && lights.has(light.parentSessionId))) ids.push(light.sessionId)
          }
          readStore.markAll(ids)
        } else if (body?.sessionId) {
          const id = String(body.sessionId)
          if (!lights.has(id)) {
            sendJson(res, 404, { error: 'unknown session' })
            return
          }
          readStore.mark(id)
        } else {
          sendJson(res, 400, { error: 'sessionId or all required' })
          return
        }
        sendJson(res, 200, { ok: true, summary: build().summary })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: focusPath,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await jsonBody(req)
        const id = body?.sessionId ? String(body.sessionId) : ''
        if (!id) {
          sendJson(res, 400, { error: 'sessionId required' })
          return
        }
        if (!lights.has(id)) {
          sendJson(res, 404, { error: 'unknown session' })
          return
        }
        focusRequests.push({ id, at: nowMs() })
        while (focusRequests.length > 20) focusRequests.shift()
        readStore.mark(id)
        bringAppToFront()
        sendJson(res, 200, { ok: true, pending: focusRequests.length })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ackPath,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await jsonBody(req)
        const ids = Array.isArray(body?.ids) ? body.ids.map(String) : []
        if (ids.length === 0) {
          focusRequests.length = 0
        } else {
          for (const id of ids) {
            const at = focusRequests.findIndex((entry) => entry.id === id)
            if (at >= 0) focusRequests.splice(at, 1)
          }
        }
        sendJson(res, 200, { ok: true, pending: focusRequests.length })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: reportPath,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await jsonBody(req)
        clientReports.push({
          at: nowMs(),
          kind: String(body?.kind ?? 'info').slice(0, 48),
          message: String(body?.message ?? '').slice(0, 400),
          sessionId: body?.sessionId ? String(body.sessionId) : null,
        })
        while (clientReports.length > 20) clientReports.shift()
        sendJson(res, 200, { ok: true })
      },
    }),
  )

  /* Read-only diagnostics: last N session events (type/seq/time only, no tool arguments),
     so the light's timing can be compared against the Chat panel's own clock. */
  const eventsPath = `${statePath}/events`
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: eventsPath,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const id = url.searchParams.get('sessionId') ?? ''
        if (!id) {
          sendJson(res, 400, { error: 'sessionId required' })
          return
        }
        const query = ctx.get('sessionQuery')
        if (typeof query?.listEvents !== 'function') {
          sendJson(res, 501, { error: 'listEvents unavailable' })
          return
        }
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 40) || 40))
        const only = url.searchParams.get('only') ?? ''
        let records = []
        try {
          records = await query.listEvents(id)
        } catch (error) {
          sendJson(res, 500, { error: errorText(error) })
          return
        }
        if (only === 'turns') {
          records = records.filter((record) => record?.type === 'turn/start' || record?.type === 'turn/end')
        }
        const events = [...records].slice(-limit).map((record) => {
          const data = record?.data ?? {}
          const row = { type: record?.type, seq: record?.seq, time: record?.time }
          if (record?.type === 'turn/start' || record?.type === 'turn/end') {
            row.turn = data.turn
            if (record?.type === 'turn/end') row.reason = data.reason?.kind ?? null
          }
          if (record?.type === 'tool/call' || record?.type === 'tool/result') row.tool = data.name ?? null
          return row
        })
        sendJson(res, 200, { sessionId: id, count: records.length, events })
      },
    }),
  )

  /* ------------------------------------------------------- desktop window */

  const companionScript = () => {
    try {
      return join(dirname(fileURLToPath(import.meta.url)), 'companion', 'traffic-light.ps1')
    } catch {
      return null
    }
  }

  /* Bring the Harness window forward so a click on the card lands somewhere the user can
     see: the Client half switches sessions only while its page is alive, and a minimized
     window also throttles its 1s poll. */
  const focusScript = () => {
    try {
      return join(dirname(fileURLToPath(import.meta.url)), 'companion', 'focus-window.ps1')
    } catch {
      return null
    }
  }

  let lastForegroundAt = 0
  const bringAppToFront = () => {
    if (windowConfig.focusApp === false) return
    const subprocess = ctx.get('subprocess')
    if (typeof subprocess?.spawn !== 'function') return
    const at = nowMs()
    if (at - lastForegroundAt < 700) return
    lastForegroundAt = at
    const script = focusScript()
    if (!script) return
    try {
      const handle = subprocess.spawn({
        argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        cwd: dirname(script),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 3000,
      })
      logFocus('spawn')
      Promise.resolve(handle?.done)
        .then((outcome) => logFocus('exit', JSON.stringify(outcome ?? null)))
        .catch((error) => logFocus('error', errorText(error)))
    } catch (error) {
      companion.error = String(error?.message ?? error)
      logFocus('spawn-failed', companion.error)
    }
  }

  const launchCompanion = () => {
    if (companion.launched || windowConfig.enabled === false) return
    const subprocess = ctx.get('subprocess')
    const server = ctx.get('webServer')
    if (typeof subprocess?.spawn !== 'function' || typeof server?.getOrigin !== 'function') return
    const script = companionScript()
    if (!script) return
    const origin = server.getOrigin()
    if (!origin) return
    const url = `${String(origin).replace(/\/$/, '')}${statePath}`
    const argv = [
      'powershell.exe',
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-BaseUrl',
      url,
      '-RefreshMs',
      String(Number(windowConfig.refreshMs) || 1000),
      '-Opacity',
      String(Number(windowConfig.opacity) || 1),
      '-Width',
      String(Number(windowConfig.width) || 300),
    ]
    try {
      const handle = subprocess.spawn({
        argv,
        cwd: dirname(script),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 32 * 1024, spill: { maxBytes: 256 * 1024 } },
          stderr: { maxBytes: 32 * 1024, spill: { maxBytes: 256 * 1024 } },
        },
        graceMs: 3000,
      })
      companion.handle = handle
      companion.launched = true
      companion.error = null
      Promise.resolve(handle.done)
        .then((outcome) => {
          companion.handle = null
          companion.lastExit = outcome ?? null
        })
        .catch((error) => {
          companion.handle = null
          companion.error = errorText(error)
        })
    } catch (error) {
      companion.error = errorText(error)
    }
  }

  ctx.effect(() => () => {
    for (const timer of idleTimers.values()) clearTimeout(timer)
    idleTimers.clear()
    try {
      companion.handle?.terminate?.()
    } catch {
      /* already gone */
    }
  })

  ctx.effect(() => {
    const boot = setTimeout(() => {
      launchCompanion()
    }, 2500)
    if (typeof boot.unref === 'function') boot.unref()
    return () => clearTimeout(boot)
  })

  /* ------------------------------------------------------------ reconcile */

  let swept = false
  const sweep = async () => {
    if (swept) return
    const agents = ctx.get('agents')
    const query = ctx.get('sessionQuery')
    if (typeof agents?.list !== 'function' || typeof query?.listEvents !== 'function') return
    swept = true

    const liveIds = new Set()
    for (const agent of agents.list()) {
      if (agent?.id) liveIds.add(String(agent.id))
    }
    if (liveIds.size === 0) return

    if (typeof query.listSessions === 'function') {
      try {
        const records = await query.listSessions()
        for (const record of Array.isArray(records) ? records : []) {
          const header = record?.header
          if (!header?.id || !liveIds.has(String(header.id))) continue
          const light = lightFor(header.id)
          if (header.cwd) light.cwd = header.cwd
          if (header.parentSession) light.parentSessionId = header.parentSession
          if (header.origin) light.origin = header.origin
        }
      } catch {
        /* cwd is cosmetic */
      }
    }

    for (const id of liveIds) {
      const light = lightFor(id)
      try {
        const records = await query.listEvents(id)
        const all = Array.isArray(records) ? records : []
        let lastStart = -1
        let lastEnd = -1
        let startTime = null
        let endTime = null
        for (const record of all) {
          const seq = typeof record?.seq === 'number' ? record.seq : -1
          const at = typeof record?.time === 'number' ? record.time : null
          if (record?.type === 'turn/start' && seq > lastStart) {
            lastStart = seq
            startTime = at
          }
          if (record?.type === 'turn/end' && seq > lastEnd) {
            lastEnd = seq
            endTime = at
          }
        }
        const running = lastStart > lastEnd
        if (running) {
          light.running = true
          /* Same clock as the app: the start of the Turn that is actually open. A guessed
             timestamp (plugin loaded late, missed the event) is replaced by the real one. */
          if (startTime != null && (!light.startedAtExact || (light.completedAt ?? 0) > startTime)) {
            light.startedAt = startTime
            light.startedAtExact = true
          } else if (light.startedAt == null) {
            light.startedAt = nowMs()
            light.startedAtExact = false
          }
          light.completedAt = null
          if (!light.waiting) setState(light, STATE.RUNNING)
        } else if (light.state === STATE.IDLE && endTime != null) {
          light.completedAt = light.completedAt ?? endTime
        }
      } catch {
        /* best effort: keep the light as it is */
      }
      refreshTitle(light)
    }
  }

  const reconcile = () => {
    const agents = ctx.get('agents')
    const list = typeof agents?.list === 'function' ? agents.list() : []
    const live = new Set()
    for (const agent of Array.isArray(list) ? list : []) {
      if (!agent?.id) continue
      live.add(String(agent.id))
      const light = lightFor(agent.id)
      if (!titles.has(light.sessionId) && !light.title) refreshTitle(light)
    }
    for (const [id, light] of lights) {
      /* a dismissed question leaves neither `tool/result` nor `turn/end`: if nothing at
         all happened for a couple of minutes, stop pretending someone is waiting */
      if (
        light.waiting?.kind === 'question' &&
        light.waiting.tool &&
        nowMs() - light.lastActivityAt > 120_000
      ) {
        clearWaiting(light)
        setState(light, light.running ? STATE.RUNNING : STATE.IDLE)
      }
      if (light.running && !live.has(id)) {
        light.running = false
        if (light.state === STATE.RUNNING) setState(light, light.error ? STATE.ERROR : STATE.IDLE)
      }
      if (!light.running && light.state === STATE.IDLE && nowMs() - light.lastActivityAt > config.staleIdleMs) {
        lights.delete(id)
      }
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        sweep().catch(() => {})
        reconcile()
      } catch {
        /* keep the timer alive */
      }
    }, config.reconcileMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  ctx.effect(() => {
    const boot = setTimeout(() => {
      sweep().catch(() => {})
    }, 1500)
    if (typeof boot.unref === 'function') boot.unref()
    return () => clearTimeout(boot)
  })
}
