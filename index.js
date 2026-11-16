import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const STATE = Object.freeze({
  RUNNING: 'running',
  WAITING: 'waiting',
  ERROR: 'error',
  /* the Turn ended but not cleanly: truncated output, hit a limit, was blocked.
     It is a result, not a failure — loud enough to notice, not the same as red. */
  ANOMALY: 'anomaly',
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
    /* 0 = the card grows with its rows; a positive value caps the height and scrolls rows.
       The card remembers the value picked from its right-click menu afterwards. */
    maxHeight: 0,
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
  /* Last few raw event/request shapes (key names only, never values) so an undocumented
     event schema can be inspected from /state without a debugger attached. */
  const probe = []
  const recordProbe = (kind, payload) => {
    let sample = ''
    try {
      sample = JSON.stringify(payload) ?? ''
    } catch {
      sample = '[unserializable]'
    }
    probe.push({ at: nowMs(), kind, sample: sample.slice(0, 600) })
    /* rolling window: keep the newest entries, drop the oldest (a frozen buffer hid the
       latest question entirely while debugging) */
    while (probe.length > 60) probe.shift()
  }
  /* Synthetic rows injected by POST /debug/anomaly, so the orange "anomaly" lamp can be
     inspected on the real card without waiting for a turn that actually gets truncated.
     Each row removes itself after `seconds`; nothing else in the plugin reads this list. */
  const debugLights = []
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
        warning: null,
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
    if (light.state === STATE.ANOMALY) return unread ? 'orange' : 'grey'
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
         also leaves no `tool/result`, hence the waiting flag is dropped here too.
         A question the app still shows (`projected`) outranks this: the turn can look
         stopped while the answer is pending, and that lamp must stay red. */
      if (light.waiting?.projected) {
        light.completedAt = nowMs()
        return
      }
      clearWaiting(light, 'status-false')
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
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      recordProbe(event.type, {
        keys: Object.keys(data),
        callId: data.callId ?? null,
        name: data.name ?? null,
        toolName: data.toolName ?? null,
      })
    }
    light.lastActivityAt = nowMs()
    if (!light.cwd && session?.header?.cwd) light.cwd = session.header.cwd
    if (!light.parentSessionId && session?.header?.parentSession) light.parentSessionId = session.header.parentSession

    /* A dismissed question emits no `tool/result`, so the fallback waiting state would
       stick forever. A model reply or any *other* tool call proves the question is gone. */
    if (light.waiting?.kind === 'question' && light.waiting.tool && !light.waiting.projected) {
      const isQuestionCall =
        event.type === 'tool/call' && QUESTION_TOOLS.has(String(data.name ?? '').toLowerCase())
      if (event.type === 'assistant/message' || (event.type === 'tool/call' && !isQuestionCall)) {
        clearWaiting(light, 'activity')
        if (light.state === STATE.WAITING) setState(light, light.running ? STATE.RUNNING : STATE.IDLE)
      }
    }

    switch (event.type) {
      case 'turn/start':
        /* a fresh Turn means whatever was pending belongs to a finished Turn — unless the
           projection still shows the question open (it would be re-added a tick later anyway) */
        if (!light.waiting?.projected) clearWaiting(light, 'turn-start')
        light.running = true
        light.turn = data.turn ?? light.turn
        light.step = null
        light.tool = null
        light.toolSince = null
        light.error = null
        light.warning = null
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
          /* the card is still on screen while the projection says so: a `pending` result for
             ask_user_question arrives before the user has answered */
          if (light.waiting?.kind === 'question' && light.waiting.tool && !light.waiting.projected) {
            waitingOff(light)
          }
        }
        break
      }
      case 'turn/end': {
        const reason = data.reason ?? {}
        /* A pending question/approval the projection still reports outranks the Turn ending:
           `ask_user_question` can end its Turn while the card sits there waiting for the
           answer, and dropping the lamp here made the red light fall back to yellow. */
        if (!light.waiting?.projected) clearWaiting(light, 'turn-end')
        light.endedReason = endedLabel(reason.kind)
        light.running = false
        light.tool = null
        light.toolSince = null
        const endedAt = typeof event.time === 'number' ? event.time : nowMs()
        if (reason.kind === 'completed') {
          light.completedAt = endedAt
          light.warning = null
          if (!light.waiting) setState(light, STATE.DONE)
        } else if (reason.kind === 'error') {
          light.completedAt = endedAt
          light.error = errorText(reason.error)
          setState(light, STATE.ERROR)
        } else if (reason.kind === 'blocked') {
          light.completedAt = endedAt
          light.error = 'blocked'
          setState(light, STATE.ERROR)
        } else if (reason.kind === 'max-tokens') {
          /* answered, but the answer was cut off: keep it visible as 异常 instead of
             letting it pass as a clean completion */
          light.completedAt = endedAt
          light.warning = '输出被截断'
          setState(light, STATE.ANOMALY)
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

  /* Assigned below once the projection reader exists; declared here so `waitingOn` can call
     it without tripping over the temporal dead zone. */
  let requestProjectionRefresh = () => {}

  const waitingOn = (light, waiting) => {
    if (!light) return
    light.waiting = waiting
    light.stateSince = nowMs()
    /* A question inferred from events is exact (it carries the session id), and the
       `userQuestions` projection does not track this harness's blocking asks, so nothing
       here is confirmed against it. */
    if (waiting?.kind === 'question' && !waiting.projected) requestProjectionRefresh(light.sessionId)
  }

  const clearWaiting = (light, why = '?') => {
    if (!light) return
    if (light.waiting) {
      recordProbe('clear', {
        id: String(light.sessionId).slice(-8),
        why,
        kind: light.waiting.kind,
        proj: Boolean(light.waiting.projected),
      })
    }
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

  /* The `userQuestions` session projection is the authoritative list of questions the app
     is still waiting on. It outlives a plugin reload (the waterfall request can fire before
     this half loads) and it clears itself when the answer settles, so the lamp follows it. */
  const QUESTION_PROJECTION = 'userQuestions'

  const questionOfProjection = (view) => {
    const active = Array.isArray(view?.active) ? view.active : []
    for (const item of active) {
      if (!item || (item.state !== 'open' && item.state !== 'continued')) continue
      const first = Array.isArray(item.questions) ? item.questions[0] : null
      const label = first?.header ?? first?.question ?? null
      return {
        callId: item.callId ? String(item.callId) : null,
        reason: typeof label === 'string' && label.trim() ? clip(label.trim(), 40) : null,
      }
    }
    return null
  }

  const applyQuestionProjection = (sessionId, view) => {
    if (!sessionId) return
    const id = String(sessionId)
    const pending = questionOfProjection(view)
    const signature = `${Array.isArray(view?.active) ? view.active.length : -1}:${Array.isArray(view?.settled) ? view.settled.length : -1}`
    if (projSeen.get(id) !== signature) {
      projSeen.set(id, signature)
      recordProbe('proj', {
        id: id.slice(-8),
        active: Array.isArray(view?.active) ? view.active.length : -1,
        settled: Array.isArray(view?.settled) ? view.settled.length : -1,
        states: (Array.isArray(view?.active) ? view.active : []).map((item) => item?.state ?? null),
        pending: Boolean(pending),
      })
    }
    if (!pending) {
      /* The projection only tracks the *timed* ask_user_question schema; this harness asks
         with the blocking schema, so an empty view proves nothing. It may only cancel a
         waiting this projection itself created — never one inferred from tool events. */
      const known = lights.get(id)
      if (known?.waiting?.projected) {
        clearWaiting(known, 'projection-empty')
        if (known.state === STATE.WAITING) setState(known, known.running ? STATE.RUNNING : STATE.IDLE)
      }
      return
    }
    const light = lights.get(id) ?? lightFor(id)
    if (light.waiting) {
      if (light.waiting.kind === 'question') {
        light.waiting.projected = true
        light.waiting.reason = pending.reason ?? light.waiting.reason
      }
      return
    }
    waitingOn(light, {
      kind: 'question',
      since: nowMs(),
      tool: 'ask_user_question',
      reason: pending.reason,
      projected: true,
    })
  }

  const projections = ctx.get('sessionProjections')
  if (projections && typeof projections.onChanged === 'function') {
    ctx.effect(() =>
      projections.onChanged((session, key, value) => {
        if (key !== QUESTION_PROJECTION) return
        const id = session?.id ?? session?.header?.id
        if (!id) return
        try {
          applyQuestionProjection(id, value)
        } catch {
          /* a projection change must never break the feed */
        }
      }),
    )
  }

  /* Read the projection for one session and let it decide the lamp's waiting state. */
  const refreshQuestionProjectionOne = async (sessionId) => {
    const query = ctx.get('sessionQuery')
    if (typeof query?.observeSession !== 'function') return
    let observation = null
    try {
      observation = await query.observeSession(String(sessionId), { projectionMode: 'all' })
      const view = observation?.projections?.values?.[QUESTION_PROJECTION]
      applyQuestionProjection(sessionId, view ?? null)
    } catch {
      /* best effort: the lamp keeps whatever state it has */
    } finally {
      try {
        observation?.dispose?.()
      } catch {
        /* already released */
      }
    }
  }

  /* A question first seen through events is re-read once after a short delay, so the lamp
     stops being clearable by the very events that follow (Turn end, status flip, tool result). */
  const pendingProjectionRefreshes = new Map()
  /* Only record projection transitions: every tick reads every hot light, so logging each
     identical empty view would flush the probe buffer within seconds. */
  const projSeen = new Map()
  requestProjectionRefresh = (sessionId) => {
    if (!sessionId) return
    const id = String(sessionId)
    if (pendingProjectionRefreshes.has(id)) return
    pendingProjectionRefreshes.set(
      id,
      setTimeout(() => {
        pendingProjectionRefreshes.delete(id)
        refreshQuestionProjectionOne(id).catch(() => {})
      }, 400),
    )
  }

  /* Catch-up read for questions that were already pending when this half loaded: the change
     feed only reports future commits, and the app keeps showing such a card until answered.
     Running/waiting lights are read every tick; the rest rotate a few per tick so a question
     that arrived while the turn looked stopped is still found within a few ticks. */
  let probeCursor = 0
  const refreshQuestionProjections = async () => {
    const query = ctx.get('sessionQuery')
    if (typeof query?.observeSession !== 'function') return
    const all = [...lights.values()]
    const hot = all.filter((light) => light.running || light.state === STATE.RUNNING || light.waiting)
    const rest = all.filter((light) => !hot.includes(light))
    const batch = []
    if (rest.length > 0) {
      const take = Math.min(rest.length, 6)
      for (let i = 0; i < take; i += 1) batch.push(rest[(probeCursor + i) % rest.length])
      probeCursor = (probeCursor + take) % rest.length
    }
    for (const light of [...hot, ...batch]) {
      await refreshQuestionProjectionOne(light.sessionId)
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
    const agentId = request?.agent?.id ?? request?.sessionId ?? null
    recordProbe('user-questions/request', {
      keys: Object.keys(request ?? {}),
      agentKeys: request?.agent ? Object.keys(request.agent) : null,
      agentId,
      sessionId: request?.sessionId ?? null,
      hasSignal: Boolean(request?.signal),
      wait: request?.wait ?? null,
      questionCount: Array.isArray(request?.questions) ? request.questions.length : null,
    })
    /* A missing `agent` used to create a phantom light keyed `undefined`, so the real
       session stayed yellow forever. Attribute it by fallback instead. */
    let light = agentId ? lightFor(agentId) : null
    if (!light) {
      const running = [...lights.values()].filter((entry) => entry.state === STATE.RUNNING && !entry.waiting)
      if (running.length === 1) light = running[0]
    }
    if (light) {
      recordProbe('wait-on', { id: String(light.sessionId).slice(-8), from: 'request' })
      waitingOn(light, {
        kind: 'question',
        since: nowMs(),
        tool: null,
        reason: clip(request?.questions?.[0]?.header ?? request?.questions?.[0]?.question ?? '', 60),
      })
    }
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
    if (light.state === STATE.ANOMALY) return 2
    if (light.state === STATE.RUNNING) return 3
    if (light.state === STATE.DONE) return 4
    return 5
  }

  const build = () => {
    const at = nowMs()
    const counts = childrenOf()
    const summary = { running: 0, waiting: 0, error: 0, anomaly: 0, done: 0, unread: 0, idle: 0, total: 0 }
    const sessions = []

    for (const light of lights.values()) {
      const readAt = readStore.readAt(light.sessionId)
      const unread = (light.state === STATE.DONE || light.state === STATE.ANOMALY) && (light.completedAt ?? 0) > readAt
      const color = colorOf(light, unread)
      const children = counts.get(light.sessionId) ?? 0
      const isChild = Boolean(light.parentSessionId && lights.has(light.parentSessionId))

      if (!isChild) {
        if (light.waiting) summary.waiting += 1
        else if (light.state === STATE.ERROR) summary.error += 1
        else if (light.state === STATE.ANOMALY) summary.anomaly += 1
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
        warning: light.warning,
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

    for (const item of debugLights) {
      if ((item.expiresAt ?? 0) <= at) continue
      sessions.push({
        id: item.id,
        short: 'debug',
        title: item.title,
        label: item.label,
        workspace: item.workspace,
        cwd: null,
        origin: null,
        parentId: null,
        children: 0,
        state: STATE.ANOMALY,
        color: 'orange',
        unread: true,
        waiting: null,
        tool: null,
        turn: null,
        error: null,
        warning: item.warning,
        endedReason: null,
        running: false,
        startedAt: at - item.elapsedMs,
        completedAt: at - 1000,
        stateSince: item.createdAt,
        lastActivityAt: at - 1000,
        elapsedMs: item.elapsedMs,
        exactStart: true,
        debug: true,
      })
      summary.anomaly += 1
      summary.unread += 1
    }

    summary.total = summary.running + summary.waiting + summary.error + summary.anomaly + summary.done + summary.idle

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
    probe: probe.slice(-12),
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

  /* Test hook for the orange lamp: POST {title?,workspace?,warning?,seconds?} adds a
     synthetic anomaly row to /state for a while; POST {} to the /clear sibling drops them. */
  const debugPath = `${statePath}/debug/anomaly`
  const debugClearPath = `${statePath}/debug/clear`
  let debugSeq = 0
  const dropExpiredDebug = () => {
    const at = nowMs()
    for (let i = debugLights.length - 1; i >= 0; i -= 1) {
      if ((debugLights[i].expiresAt ?? 0) <= at) debugLights.splice(i, 1)
    }
  }
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: debugPath,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await jsonBody(req)
        dropExpiredDebug()
        const seconds = Math.min(600, Math.max(5, Number(body?.seconds ?? 90) || 90))
        const title = String(body?.title ?? '测试会话（异常示例）').slice(0, 120)
        const workspace = String(body?.workspace ?? 'Debug').slice(0, 60)
        const warning = String(body?.warning ?? '输出被截断').slice(0, 60)
        debugSeq += 1
        debugLights.push({
          id: `debug-anomaly-${debugSeq}`,
          title,
          label: `${title} · ${workspace}`,
          workspace,
          warning,
          elapsedMs: 67_000,
          createdAt: nowMs(),
          expiresAt: nowMs() + seconds * 1000,
        })
        while (debugLights.length > 5) debugLights.shift()
        sendJson(res, 200, { ok: true, count: debugLights.length, seconds })
      },
    }),
  )
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: debugClearPath,
      handler: (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        debugLights.length = 0
        sendJson(res, 200, { ok: true })
      },
    }),
  )

  /* Read-only diagnostics: what the `userQuestions` projection currently says for one
     session, so a lamp that stays yellow while the app shows a question can be explained. */
  const questionPath = `${statePath}/debug/question`
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: questionPath,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId')
        const query = ctx.get('sessionQuery')
        if (!sessionId || typeof query?.observeSession !== 'function') {
          sendJson(res, 400, { error: 'sessionId and sessionQuery.observeSession required' })
          return
        }
        let observation = null
        try {
          observation = await query.observeSession(sessionId, { projectionMode: 'all' })
          const values = observation?.projections?.values ?? {}
          const view = values[QUESTION_PROJECTION] ?? null
          sendJson(res, 200, {
            ok: true,
            sessionId,
            projectionKeys: Object.keys(values),
            view,
            derived: questionOfProjection(view),
            light: lights.get(String(sessionId))?.waiting ?? null,
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) })
        } finally {
          try {
            observation?.dispose?.()
          } catch {
            /* already released */
          }
        }
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
        const shape = url.searchParams.get('shape') === '1'
        const events = [...records].slice(-limit).map((record) => {
          const data = record?.data ?? {}
          /* shape=1: key names and value types only (never values), so an unknown event
             schema can be inspected without exposing tool arguments. */
          if (shape) {
            const dataKeys = {}
            for (const key of Object.keys(data)) {
              const value = data[key]
              if (Array.isArray(value)) dataKeys[key] = `array(${value.length})`
              else if (value === null || value === undefined) dataKeys[key] = String(value)
              else if (typeof value === 'object') dataKeys[key] = `object{${Object.keys(value).slice(0, 10).join(',')}}`
              else dataKeys[key] = typeof value
            }
            const topKeys = {}
            for (const key of Object.keys(record ?? {})) topKeys[key] = typeof record[key]
            return { type: record?.type, seq: record?.seq, time: record?.time, topKeys, dataKeys }
          }
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
      '-MaxHeight',
      String(Math.max(0, Number(windowConfig.maxHeight) || 0)),
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
    for (const timer of pendingProjectionRefreshes.values()) clearTimeout(timer)
    pendingProjectionRefreshes.clear()
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
        !light.waiting.projected &&
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
        refreshQuestionProjections().catch(() => {})
      } catch {
        /* keep the timer alive */
      }
    }, config.reconcileMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  ctx.effect(() => {
    const boot = setTimeout(() => {
      sweep()
        .then(() => refreshQuestionProjections())
        .catch(() => {})
    }, 1500)
    if (typeof boot.unref === 'function') boot.unref()
    return () => clearTimeout(boot)
  })
}
