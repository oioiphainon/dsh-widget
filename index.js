/**
 * Host half of the 大肥鱼 (fat fish) floating widget.
 *
 * Collects live per-session task progress from the DSH Host and serves it on one
 * authenticated route of the host's `/api` channel:
 *
 *   GET /api/fat-fish/progress
 *
 * Response shape (v1, consumed verbatim by the widget's client.js):
 *   { ok:true, v:1, now, version, counts:{live,running}, sessions:[{
 *       id, title, cwd, running, phase, turn, step, turnStartedAt, elapsedMs,
 *       lastEventAt, currentTool, counts:{tools,errors,steps}, todos,
 *       todoProgress:{done,total}, jobs, goal, teamTasks }] }
 *
 * Everything is derived from optional services (`ctx.get(name)` may return
 * undefined in a slimmer composition) and from host events. No imports: the
 * plugin is plain ESM and only relies on globals (`Response`, `JSON`, `Map`).
 *
 * Phase vocabulary: queued | thinking | streaming | tool | idle | done | error.
 * `idle` = not working and no finished turn to report; `done` = the last turn
 * ended normally (completed/blocked/max-tokens); `error` = the last turn ended
 * in failure; `idle` after an abort.
 */

const PROGRESS_PATH = '/api/fat-fish/progress'
const PLUGIN_VERSION = '0.4.1'
const API_VERSION = 1

const MAX_SESSIONS = 12
const MAX_JOBS = 6
const MAX_TODOS = 12
const MAX_STORED_TODOS = 100

const TITLE_MAX = 48
const TARGET_MAX = 64
const TODO_TEXT_MAX = 80
const GOAL_OBJECTIVE_MAX = 120
const JOB_LABEL_MAX = 40
const APPROVAL_TEXT_MAX = 120
const MAX_APPROVALS = 5

/** Phases meaning "the agent is actively working right now". */
const ACTIVE_PHASES = new Set(['thinking', 'streaming', 'tool', 'approval'])
const ERROR_PHASES = new Set(['idle', 'done', 'error'])

/** One event-fold state per session, keyed per plugin context (apply/collect share it). */
const STORES = new WeakMap()

/* ------------------------------------------------------------------ helpers */

function storeFor(ctx) {
  const key = ctx !== null && (typeof ctx === 'object' || typeof ctx === 'function') ? ctx : null
  if (key === null) return new Map()
  let store = STORES.get(key)
  if (!store) {
    store = new Map()
    STORES.set(key, store)
  }
  return store
}

/** Optional-service read: a throwing or missing service must never break collection. */
function safeGet(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Collapse whitespace and hard-cap a display string (never returns undefined). */
function truncate(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sessionIdOf(session) {
  try {
    const id = session && session.id
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

function eventTypeOf(event) {
  try {
    return typeof event?.type === 'string' ? event.type : ''
  } catch {
    return ''
  }
}

/** Events carry their payload in `data`; tolerate consumers that pass it inline. */
function eventDataOf(event) {
  try {
    const data = event?.data
    return isRecord(data) ? data : isRecord(event) ? event : {}
  } catch {
    return {}
  }
}

function eventTimeOf(event) {
  try {
    return finiteOrNull(event?.time) ?? Date.now()
  } catch {
    return Date.now()
  }
}

function eventSeqOf(event) {
  try {
    return finiteOrNull(event?.seq)
  } catch {
    return null
  }
}

function parseArguments(raw) {
  if (isRecord(raw)) return raw
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function firstText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const block of value) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text
    }
    return ''
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string') return value.text
    if (Array.isArray(value.content)) return firstText(value.content)
  }
  return ''
}

/* ------------------------------------------------------------- tool targets */

const TOOL_TARGET_KEYS = {
  grep: ['pattern', 'path', 'query'],
  search: ['query', 'pattern', 'path'],
  glob: ['pattern', 'path'],
  read: ['path', 'file_path', 'filePath'],
  write: ['path', 'file_path', 'filePath'],
  edit: ['path', 'file_path', 'filePath'],
  shell: ['command', 'cmd'],
  exec: ['command', 'cmd'],
  bash: ['command', 'cmd'],
  task: ['description', 'subject', 'name'],
  subagent: ['description', 'prompt', 'name'],
  web_search: ['query', 'queries'],
  web_fetch: ['url'],
  send_message: ['target'],
  spawn_teammate: ['name', 'description'],
  team_task_update: ['task_id'],
  team_task_create: ['subject'],
  job_output: ['job_id'],
  job_kill: ['job_id'],
}

const GENERIC_TARGET_KEYS = [
  'path', 'file_path', 'filePath', 'pattern', 'query', 'command',
  'url', 'description', 'subject', 'name', 'title', 'task_id', 'job_id', 'id', 'target',
]

/** Pick the most informative short string out of a tool call's arguments. */
function deriveToolTarget(name, args) {
  if (!isRecord(args)) return ''
  const keys = TOOL_TARGET_KEYS[name] || GENERIC_TARGET_KEYS
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return truncate(value, TARGET_MAX)
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
      return truncate(value.join(' '), TARGET_MAX)
    }
  }
  return ''
}

/* -------------------------------------------------------------------- todos */

function normalizeTodoStatus(status) {
  const text = typeof status === 'string' ? status.trim().toLowerCase() : ''
  if (text === 'completed' || text === 'complete' || text === 'done') return 'completed'
  if (text === 'in_progress' || text === 'in-progress' || text === 'active' || text === 'running' || text === 'doing') {
    return 'in_progress'
  }
  return 'pending'
}

/** Normalize a `todos` array (or its JSON string form); null when unusable. */
function normalizeTodos(raw) {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!Array.isArray(value)) return null
  const todos = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const content = typeof item.content === 'string' ? item.content.trim() : ''
    if (content === '') continue
    todos.push({ content, status: normalizeTodoStatus(item.status) })
    if (todos.length >= MAX_STORED_TODOS) break
  }
  return todos
}

/* ------------------------------------------------------------------- state */

function newState(id) {
  return {
    id,
    session: null,
    header: null,
    baseline: false,
    lastSeq: null,
    turn: null,
    step: null,
    turnStartedAt: null,
    lastEventAt: null,
    running: false,
    phase: 'idle',
    title: null,
    currentTool: null,
    counts: { tools: 0, errors: 0, steps: 0 },
    todos: [],
    approvals: [],
    lastApproval: null,
    agent: null,
    agentStatus: null,
    // True when the user sent a message while a turn was still running: the
    // turn/end handler flips straight to "queued" so the widget never parks on
    // the previous turn's "完成" while the follow-up waits its turn.
    pendingUserMessage: false,
  }
}

function updatePosition(state, data) {
  const turn = finiteOrNull(data.turn)
  if (turn !== null) state.turn = turn
  const step = finiteOrNull(data.step)
  if (step !== null) state.step = step
}

function handleTurnEnd(state, data) {
  state.running = false
  state.currentTool = null
  const reason = data.reason
  const rawKind = typeof reason === 'string' ? reason : typeof reason?.kind === 'string' ? reason.kind : ''
  const kind = rawKind.toLowerCase()
  if (kind.includes('error') || kind.includes('fail')) state.phase = 'error'
  else if (kind.includes('abort') || kind.includes('cancel') || kind.includes('interrupt')) state.phase = 'idle'
  else state.phase = 'done'
  // A message the user queued mid-turn starts the next turn right away; showing
  // "完成" in that gap is what made the widget look frozen. Report "queued"
  // instead, so the badge matches what DSH is about to do.
  if (state.pendingUserMessage && state.phase === 'done') {
    state.phase = 'queued'
    state.running = true
    state.pendingUserMessage = false
  }
}

/** Fold one session event into the per-session state (idempotent by `seq`). */
function foldEvent(state, event) {
  const type = eventTypeOf(event)
  if (type === '') return

  const seq = eventSeqOf(event)
  if (seq !== null) {
    if (state.lastSeq !== null && seq <= state.lastSeq) return
    state.lastSeq = seq
  }

  const data = eventDataOf(event)
  const time = eventTimeOf(event)
  state.lastEventAt = state.lastEventAt === null ? time : Math.max(state.lastEventAt, time)

  switch (type) {
    case 'turn/start':
      updatePosition(state, data)
      state.turnStartedAt = time
      state.phase = 'queued'
      state.running = true
      state.currentTool = null
      state.step = null
      state.approvals = []
      state.pendingUserMessage = false
      break

    case 'turn/end':
      updatePosition(state, data)
      handleTurnEnd(state, data)
      state.approvals = []
      break

    case 'step/start':
      updatePosition(state, data)
      state.counts.steps += 1
      state.phase = 'thinking'
      state.running = true
      break

    case 'assistant/attempt':
      updatePosition(state, data)
      state.phase = 'thinking'
      state.running = true
      break

    case 'assistant/message':
      updatePosition(state, data)
      state.phase = 'streaming'
      state.running = true
      break

    case 'tool/call': {
      updatePosition(state, data)
      const name = typeof data.name === 'string' && data.name !== '' ? data.name : 'tool'
      const args = parseArguments(data.arguments ?? data.args ?? data.input)
      state.currentTool = { name, target: deriveToolTarget(name, args), startedAt: time }
      state.counts.tools += 1
      state.phase = 'tool'
      state.running = true
      if (name === 'todo_write') {
        const todos = normalizeTodos(args.todos)
        if (todos !== null) state.todos = todos
      }
      break
    }

    case 'tool/result': {
      updatePosition(state, data)
      const failed = Boolean(data.error) || data.isError === true || data.message?.isError === true
      state.currentTool = null
      if (failed) {
        state.counts.errors += 1
        state.phase = 'error'
      } else {
        state.phase = 'thinking'
      }
      state.running = true
      break
    }

    case 'session/title': {
      const title = typeof data.title === 'string' ? data.title.trim() : ''
      if (title !== '') state.title = truncate(title, TITLE_MAX)
      break
    }

    // Approval requests are durable session events, so the desktop widget can
    // show a popup without hooking the approval waterfall (which would risk
    // breaking the decision chain).
    case 'approval/asked': {
      const rawId = data.id === null || data.id === undefined ? String(seq ?? time) : String(data.id)
      const toolName = typeof data.toolName === 'string' && data.toolName !== '' ? data.toolName : 'tool'
      const reason = typeof data.reason === 'string' ? data.reason : ''
      const target = state.currentTool && state.currentTool.name === toolName ? state.currentTool.target : ''
      state.approvals = state.approvals.filter((item) => item.id !== rawId)
      state.approvals.push({
        id: rawId,
        toolName,
        reason: truncate(reason, APPROVAL_TEXT_MAX),
        target: truncate(target || '', APPROVAL_TEXT_MAX),
        at: time,
      })
      if (state.approvals.length > MAX_APPROVALS) state.approvals = state.approvals.slice(-MAX_APPROVALS)
      state.phase = 'approval'
      state.running = true
      break
    }

    case 'approval/decided': {
      const rawId = data.id === null || data.id === undefined ? '' : String(data.id)
      const before = state.approvals.length
      const decided = state.approvals.find((item) => item.id === rawId) ?? null
      state.approvals = state.approvals.filter((item) => item.id !== rawId)
      if (before !== state.approvals.length) {
        if (state.phase === 'approval') state.phase = state.running ? 'tool' : 'idle'
      }
      // Keep the verdict so the widget can flash "已允许 / 已拒绝" once. Outcome
      // values come straight from the session event: allowed-once | rejected |
      // cancelled | unavailable.
      state.lastApproval = {
        id: rawId,
        toolName: decided ? decided.toolName : '',
        outcome: typeof data.outcome === 'string' ? data.outcome : 'unknown',
        at: time,
      }
      break
    }

    case 'user/message': {
      if (state.title === null) {
        const message = isRecord(data.message) ? data.message : data
        const text = firstText(message.content ?? message.text ?? data.content)
        const title = truncate(text, TITLE_MAX)
        if (title !== '') state.title = title
      }
      // A user message means a turn is about to start. Flip the badge right
      // away instead of leaving the previous turn's "完成" up while the agent
      // boots (that gap read as lag).
      if (!ACTIVE_PHASES.has(state.phase)) {
        state.running = true
        state.phase = 'queued'
        state.currentTool = null
      } else {
        // Mid-turn steering: the agent keeps working, but remember the queued
        // message so turn/end can report "排队中…" instead of "完成".
        state.pendingUserMessage = true
      }
      break
    }

    case 'todo/write': {
      const todos = normalizeTodos(data.todos)
      if (todos !== null) state.todos = todos
      break
    }

    default:
      // Sessions carry many event types this widget does not need; the event
      // still advanced lastEventAt above, which is enough for ordering.
      break
  }
}

function applyAgentStatus(state, status) {
  state.agentStatus = status
  if (status === 'running') {
    state.running = true
    if (ERROR_PHASES.has(state.phase)) state.phase = 'queued'
  } else {
    state.running = false
    if (ACTIVE_PHASES.has(state.phase)) state.phase = 'idle'
  }
}

/** Fold the session's committed history exactly once. */
function ensureBaseline(state, session) {
  if (state.baseline) return
  let snapshot = null
  try {
    if (typeof session.snapshotEvents !== 'function') {
      state.baseline = true
      return
    }
    snapshot = session.snapshotEvents()
  } catch {
    return // retry on a later poll
  }
  state.baseline = true
  let events = null
  if (Array.isArray(snapshot)) events = snapshot
  else if (snapshot && typeof snapshot[Symbol.iterator] === 'function') events = Array.from(snapshot)
  if (!events) return
  for (const event of events) {
    try {
      foldEvent(state, event)
    } catch {
      /* one malformed event must not poison the rest of the history */
    }
  }
}

function ensureState(store, session, services) {
  const id = sessionIdOf(session)
  if (id === null) return null
  let state = store.get(id)
  if (!state) {
    state = newState(id)
    store.set(id, state)
  }
  state.session = session
  try {
    state.header = isRecord(session.header) ? session.header : null
  } catch {
    state.header = null
  }
  ensureBaseline(state, session)
  reconcileAgent(state, services, id)
  return state
}

function reconcileAgent(state, services, sessionId) {
  const agents = services.agents
  if (!agents || typeof agents.get !== 'function') return
  let agent
  try {
    agent = agents.get(sessionId)
  } catch {
    return
  }
  if (!isRecord(agent)) {
    state.agent = null
    return
  }
  state.agent = agent
  // Fall back to the live registry only when no agent/status edge was observed.
  if (state.agentStatus === null) {
    let status = null
    try {
      status = agent.status
    } catch {
      status = null
    }
    if (status === 'running' || status === 'idle') applyAgentStatus(state, status)
  }
}

/* ------------------------------------------------------- optional services */

function listSessions(sessions) {
  if (!sessions || typeof sessions.list !== 'function') return []
  try {
    const list = sessions.list()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function sessionJobs(services, sessionId) {
  const jobs = services.jobs
  if (!jobs || typeof jobs.list !== 'function') return []
  let list = null
  try {
    list = jobs.list(sessionId)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []

  const views = []
  for (const job of list) {
    if (!isRecord(job)) continue
    const id = typeof job.id === 'string' ? job.id : job.id !== undefined && job.id !== null ? String(job.id) : ''
    if (id === '') continue
    const progress =
      typeof job.progress === 'number' && Number.isFinite(job.progress)
        ? job.progress
        : typeof job.progress === 'string'
          ? job.progress
          : null
    views.push({
      id,
      label: truncate(job.label, JOB_LABEL_MAX),
      status: typeof job.status === 'string' ? job.status : 'unknown',
      progress,
      startedAt: finiteOrNull(job.startedAt),
    })
  }

  // Running jobs first, then most recently started.
  views.sort((a, b) => {
    const aRunning = a.status === 'running' ? 0 : 1
    const bRunning = b.status === 'running' ? 0 : 1
    if (aRunning !== bRunning) return aRunning - bRunning
    const aStarted = a.startedAt === null ? -Infinity : a.startedAt
    const bStarted = b.startedAt === null ? -Infinity : b.startedAt
    return bStarted - aStarted
  })
  return views.slice(0, MAX_JOBS)
}

function sessionGoal(services, agent) {
  if (!agent) return null
  const goals = services.goals
  if (!goals || typeof goals.get !== 'function') return null
  let view = null
  try {
    view = goals.get(agent)
  } catch {
    return null
  }
  if (!isRecord(view) || typeof view.objective !== 'string' || view.objective.trim() === '') return null
  return {
    objective: truncate(view.objective, GOAL_OBJECTIVE_MAX),
    phase: typeof view.phase === 'string' && view.phase !== '' ? view.phase : 'active',
    roundsStarted: finiteOrNull(view.roundsStarted) ?? 0,
    maxGoalRounds: finiteOrNull(view.maxGoalRounds) ?? 0,
  }
}

function sessionTeamTasks(services, agent) {
  if (!agent) return null
  const teams = services.agentTeams
  if (!teams) return null
  let membership = null
  try {
    if (typeof teams.tryMembership === 'function') membership = teams.tryMembership(agent)
  } catch {
    return null
  }
  if (!membership) return null
  let tasks = null
  try {
    if (typeof teams.listTasks === 'function') tasks = teams.listTasks(agent)
  } catch {
    return null
  }
  if (!Array.isArray(tasks)) return null
  const views = []
  for (const task of tasks) {
    if (!isRecord(task)) continue
    const id = typeof task.id === 'string' ? task.id : task.id !== undefined && task.id !== null ? String(task.id) : ''
    if (id === '') continue
    views.push({
      id,
      subject: typeof task.subject === 'string' ? task.subject : '',
      status: typeof task.status === 'string' ? task.status : 'unknown',
    })
  }
  return views
}

/* --------------------------------------------------------------- serializing */

function serializeSession(state, services, now) {
  const turnStartedAt = finiteOrNull(state.turnStartedAt)
  const lastEventAt = finiteOrNull(state.lastEventAt) ?? finiteOrNull(state.header?.createdAt) ?? now

  let phase = state.phase
  let running = Boolean(state.running)
  if (state.agentStatus === 'running') running = true
  else if (state.agentStatus === 'idle') running = false

  if (running && ERROR_PHASES.has(phase)) phase = 'queued'
  else if (!running && ACTIVE_PHASES.has(phase)) phase = 'idle'

  // A pending approval blocks the agent: keep it "running" and surface the
  // dedicated phase even if a status edge briefly reported idle.
  const pendingApprovals = Array.isArray(state.approvals) ? state.approvals.length : 0
  if (pendingApprovals > 0) {
    running = true
    phase = 'approval'
  }

  const elapsedMs = running && turnStartedAt !== null ? Math.max(0, now - turnStartedAt) : null
  const todos = state.todos.slice(0, MAX_TODOS)
  const done = state.todos.reduce((count, todo) => count + (todo.status === 'completed' ? 1 : 0), 0)

  return {
    id: state.id,
    title: state.title !== null ? truncate(state.title, TITLE_MAX) : '新对话',
    cwd: typeof state.header?.cwd === 'string' ? state.header.cwd : null,
    running,
    phase,
    turn: finiteOrNull(state.turn) ?? 0,
    step: finiteOrNull(state.step) ?? 0,
    turnStartedAt,
    elapsedMs,
    lastEventAt,
    currentTool:
      phase === 'tool' && isRecord(state.currentTool)
        ? {
            name: truncate(state.currentTool.name, TARGET_MAX),
            target: truncate(state.currentTool.target, TARGET_MAX),
            startedAt: finiteOrNull(state.currentTool.startedAt) ?? lastEventAt,
          }
        : null,
    counts: {
      tools: state.counts.tools,
      errors: state.counts.errors,
      steps: state.counts.steps,
    },
    todos: todos.map((todo) => ({
      content: truncate(todo.content, TODO_TEXT_MAX),
      status: todo.status,
    })),
    todoProgress: { done, total: state.todos.length },
    jobs: sessionJobs(services, state.id),
    goal: sessionGoal(services, state.agent),
    teamTasks: sessionTeamTasks(services, state.agent),
  }
}

/* ----------------------------------------------------------------- collector */

function errorPayload(now) {
  return { ok: false, v: API_VERSION, now, error: 'internal', sessions: [] }
}

export function collectProgress(ctx) {
  const now = Date.now()
  try {
    const store = storeFor(ctx)
    const services = {
      sessions: safeGet(ctx, 'sessions'),
      agents: safeGet(ctx, 'agents'),
      jobs: safeGet(ctx, 'jobs'),
      goals: safeGet(ctx, 'goals'),
      agentTeams: safeGet(ctx, 'agentTeams'),
    }

    const sessions = listSessions(services.sessions)
    const items = []
    let running = 0
    for (const session of sessions) {
      try {
        const state = ensureState(store, session, services)
        if (!state) continue
        const item = serializeSession(state, services, now)
        if (item.running) running += 1
        items.push(item)
      } catch {
        /* a single broken session must not hide the others */
      }
    }

    items.sort((a, b) => {
      if (b.lastEventAt !== a.lastEventAt) return b.lastEventAt - a.lastEventAt
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    const approvals = []
    for (const state of store.values()) {
      if (!Array.isArray(state.approvals) || state.approvals.length === 0) continue
      const title = state.title !== null ? state.title : ''
      for (const item of state.approvals) {
        approvals.push({
          id: item.id,
          sessionId: state.id,
          sessionTitle: title,
          toolName: item.toolName,
          reason: item.reason,
          target: item.target,
          at: item.at,
        })
      }
    }
    approvals.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))

    // Most recent verdict across all sessions; the widget uses it to flash a
    // short "已允许 / 已拒绝" confirmation and then forgets about it.
    let lastApproval = null
    for (const state of store.values()) {
      const decided = state.lastApproval
      if (decided === null || decided === undefined) continue
      if (lastApproval !== null && (decided.at ?? 0) <= (lastApproval.at ?? 0)) continue
      lastApproval = {
        id: decided.id,
        sessionId: state.id,
        sessionTitle: state.title !== null ? state.title : '',
        toolName: decided.toolName,
        outcome: decided.outcome,
        at: decided.at,
      }
    }

    return {
      ok: true,
      v: API_VERSION,
      now,
      version: PLUGIN_VERSION,
      counts: { live: sessions.length, running },
      approvals: approvals.slice(0, MAX_SESSIONS),
      lastApproval,
      sessions: items.slice(0, MAX_SESSIONS),
    }
  } catch {
    return errorPayload(now)
  }
}

/* --------------------------------------------------------------- events/routes */

function handleSessionEvent(store, session, event) {
  try {
    const id = sessionIdOf(session)
    if (id === null) return
    let state = store.get(id)
    if (!state) {
      state = newState(id)
      state.session = session
      store.set(id, state)
    }
    foldEvent(state, event)
  } catch {
    /* host event delivery must stay quiet */
  }
}

function findStateForAgent(store, agent) {
  if (!isRecord(agent)) return null
  const id = typeof agent.id === 'string' ? agent.id : null
  if (id !== null) {
    const byId = store.get(id)
    if (byId) return byId
  }
  for (const state of store.values()) {
    if (state.agent === agent) return state
  }
  return null
}

function handleAgentStatus(store, payload) {
  try {
    const agent = isRecord(payload) ? payload.agent : null
    const status = isRecord(payload) && typeof payload.status === 'string' ? payload.status : null
    if (status !== 'running' && status !== 'idle') return
    const state = findStateForAgent(store, agent)
    if (!state) return
    if (isRecord(agent)) state.agent = agent
    applyAgentStatus(state, status)
  } catch {
    /* ignore */
  }
}

function handleAgentDisposed(store, payload) {
  try {
    const agent = isRecord(payload) ? payload.agent : null
    const state = findStateForAgent(store, agent)
    if (!state) return
    state.agent = null
    state.agentStatus = null
    state.running = false
    if (!ERROR_PHASES.has(state.phase)) state.phase = 'idle'
  } catch {
    /* ignore */
  }
}

function handleSessionDisposed(store, session) {
  try {
    const id = sessionIdOf(session)
    if (id !== null) store.delete(id)
  } catch {
    /* ignore */
  }
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function registerRoute(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['connection'], (scope) => {
      try {
        const connection = scope && typeof scope.get === 'function' ? scope.get('connection') : undefined
        const fetchService = connection?.fetch
        if (typeof fetchService?.register !== 'function') return
        const register = fetchService.register.bind(fetchService)
        if (typeof scope.effect !== 'function') {
          register({
            path: PROGRESS_PATH,
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: async () => {
              try {
                return jsonResponse(collectProgress(ctx))
              } catch {
                return jsonResponse(errorPayload(Date.now()))
              }
            },
          })
          return
        }
        scope.effect(() => register({
          path: PROGRESS_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () => {
            try {
              return jsonResponse(collectProgress(ctx))
            } catch {
              return jsonResponse(errorPayload(Date.now()))
            }
          },
        }), 'fat-fish: progress route')
      } catch {
        /* a host without the route channel simply has no widget route */
      }
    })
  } catch {
    /* injection failure must not break plugin load */
  }
}

/* ----------------------------------------------------- desktop state bridge */

/**
 * The desktop widget is a separate always-on-top process; the browser token that
 * guards `/api/fat-fish/progress` is not available to it, so the Host mirrors the
 * same snapshot to a small JSON file it can read:
 *
 *   %LOCALAPPDATA%\dsh-fat-fish\state.json
 *
 * Node builtins are resolved through `process.getBuiltinModule` so the module
 * keeps its zero-import shape and stays loadable in every profile.
 */
function builtin(name) {
  try {
    const proc = typeof globalThis !== 'undefined' ? globalThis.process : undefined
    if (proc && typeof proc.getBuiltinModule === 'function') return proc.getBuiltinModule(name)
  } catch {
    /* ignore */
  }
  return null
}

/** Absolute path of the snapshot consumed by desktop/FatFishDesktop.ps1. */
export function desktopStatePath() {
  try {
    const path = builtin('node:path')
    const env = builtin('node:process')?.env ?? {}
    if (!path) return null
    const base = env.LOCALAPPDATA || env.APPDATA || env.HOME
    if (!base) return null
    return path.join(base, 'dsh-fat-fish', 'state.json')
  } catch {
    return null
  }
}

/* --------------------------------------------------------------- debug tap */

/**
 * Optional diagnostic tap: while `%LOCALAPPDATA%\dsh-fat-fish\debug-on` exists,
 * session events and published snapshots are appended to `debug.log` so timing
 * between an event and the widget's file can be measured (never throws).
 */
let debugFlag = { at: 0, on: false }
let debugReset = false

function debugEnabled() {
  const now = Date.now()
  if (now - debugFlag.at < 1500) return debugFlag.on
  debugFlag.at = now
  debugFlag.on = false
  try {
    const fs = builtin('node:fs')
    const path = builtin('node:path')
    const state = desktopStatePath()
    if (fs && path && state) debugFlag.on = fs.existsSync(path.join(path.dirname(state), 'debug-on'))
  } catch {
    debugFlag.on = false
  }
  return debugFlag.on
}

function debugLog(text) {
  if (!debugEnabled()) return
  try {
    const fs = builtin('node:fs')
    const path = builtin('node:path')
    const state = desktopStatePath()
    if (!fs || !path || !state) return
    const file = path.join(path.dirname(state), 'debug.log')
    const line = `${new Date().toISOString()} ${text}\n`
    if (!debugReset) {
      debugReset = true
      fs.writeFileSync(file, line)
    } else {
      fs.appendFileSync(file, line)
    }
  } catch {
    /* ignore */
  }
}

/** Mirror the current progress snapshot to disk (atomic replace). */
let pruneCounter = 0
function publishDesktopState(ctx) {
  try {
    const fs = builtin('node:fs')
    const path = builtin('node:path')
    if (!fs || !path || typeof fs.writeFileSync !== 'function') return
    const file = desktopStatePath()
    if (!file) return
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const payload = { ...collectProgress(ctx), writtenAt: Date.now() }
    try {
      const first = Array.isArray(payload.sessions) && payload.sessions[0] ? payload.sessions[0] : null
      debugLog(
        `publish sessions=${Array.isArray(payload.sessions) ? payload.sessions.length : 0}` +
          (first
            ? ` sid=${String(first.id).slice(-6)} turn=${first.turn} step=${first.step} phase=${first.phase}` +
              ` running=${first.running} tools=${first.counts?.tools} todo=${first.todoProgress?.done}/${first.todoProgress?.total}`
            : ''),
      )
    } catch {
      /* ignore */
    }
    const tmp = `${file}.${Math.floor(Math.random() * 1e6)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload))
    try {
      fs.renameSync(tmp, file)
    } catch (error) {
      // The previous snapshot is briefly locked (e.g. a slow reader without
      // FILE_SHARE_DELETE); retry once, then drop the temp file and let the
      // next tick (~800 ms) try again.
      try {
        fs.renameSync(tmp, file)
      } catch {
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* ignore */
        }
      }
    }
    pruneCounter = (pruneCounter + 1) % 75
    if (pruneCounter === 0) {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith('state.json.') && name.endsWith('.tmp')) {
            try {
              fs.unlinkSync(path.join(dir, name))
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* a locked or read-only disk must not disturb the session */
  }
}

/* ---------------------------------------------------------- publish timing */

/**
 * Event-driven snapshot pushes: waiting for the 800 ms heartbeat made fresh
 * steps show up noticeably late on the desktop widget, so every session event
 * schedules an extra publish a few dozen ms later (coalesced, so bursts stay
 * cheap). Turn boundaries (and user messages / agent status flips) are pushed
 * with zero delay: those flip the whole badge, and any wait at all reads as a
 * frozen widget.
 */
let publishSoonTimer = null
let publishSoonDelay = 0

/** Events that change the badge itself; publish them without debouncing. */
const IMMEDIATE_EVENTS = new Set(['turn/start', 'turn/end', 'user/message'])

function schedulePublish(ctx, delay = 60) {
  try {
    if (typeof setTimeout !== 'function') return
    if (publishSoonTimer !== null) {
      if (delay >= publishSoonDelay) return
      clearTimeout(publishSoonTimer)
      publishSoonTimer = null
    }
    publishSoonDelay = delay
    publishSoonTimer = setTimeout(() => {
      publishSoonTimer = null
      publishSoonDelay = 0
      try {
        publishDesktopState(ctx)
      } catch {
        /* ignore */
      }
    }, delay)
    if (publishSoonTimer && typeof publishSoonTimer.unref === 'function') publishSoonTimer.unref()
  } catch {
    /* ignore */
  }
}

function startDesktopPublisher(ctx) {
  try {
    if (typeof setInterval !== 'function') return
    const tick = () => {
      try {
        publishDesktopState(ctx)
      } catch {
        /* ignore */
      }
    }
    tick()
    const timer = setInterval(tick, 800)
    if (timer && typeof timer.unref === 'function') timer.unref()
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        try {
          clearInterval(timer)
        } catch {
          /* ignore */
        }
      }, 'fat-fish: desktop state publisher')
    }
  } catch {
    /* ignore */
  }
}

/** Diagnostic trail for the widget launch (best effort, never throws). */
let launchLogReset = false
function logLaunch(message) {
  try {
    const fs = builtin('node:fs')
    const path = builtin('node:path')
    const state = desktopStatePath()
    if (!fs || !path || !state) return
    const file = path.join(path.dirname(state), 'launch.log')
    const line = `${new Date().toISOString()} ${message}\n`
    if (!launchLogReset) {
      launchLogReset = true
      fs.writeFileSync(file, line)
    } else {
      fs.appendFileSync(file, line)
    }
  } catch {
    /* ignore */
  }
}

/** Path of the desktop widget script shipped next to this module. */
function desktopWidgetScript() {
  try {
    const path = builtin('node:path')
    const url = builtin('node:url')
    if (!path || !url) return null
    const moduleUrl = import.meta?.url
    logLaunch(`module url: ${String(moduleUrl)}`)
    if (!moduleUrl) return null
    const dir = path.dirname(url.fileURLToPath(moduleUrl))
    logLaunch(`module dir: ${dir}`)
    return path.join(dir, 'desktop', 'FatFishDesktop.ps1')
  } catch (error) {
    logLaunch(`script path failed: ${String(error)}`)
    return null
  }
}

let widgetLaunchAttempted = false

/**
 * Start the desktop mascot once per Host load (0.3.3: this is the ONLY start path).
 *
 * 0.3.2 and earlier also offered a login autostart shortcut; that is gone, so the
 * widget's lifetime now begins whenever DSH opens and loads this bundle. The fish
 * still outlives the Host: it is started through desktop/launch-widget.vbs
 * (wscript → WScript.Shell.Run) rather than spawned directly, because a directly
 * spawned child inherits the Host's job object / sandbox and is torn down with it,
 * while ShellExecute-launched processes are owned by the shell and keep running.
 * The widget itself also holds a single-instance mutex, so a plugin reload while the
 * previous fish is still on the desktop never stacks a second one.
 */
function launchDesktopWidget() {
  if (widgetLaunchAttempted) return
  widgetLaunchAttempted = true
  try {
    const proc = builtin('node:process')
    const fs = builtin('node:fs')
    const path = builtin('node:path')
    const cp = builtin('node:child_process')
    if (!proc || !fs || !path || !cp) return
    if (proc.platform !== 'win32') return
    const script = desktopWidgetScript()
    if (!script) {
      logLaunch('launch: no widget script path')
      return
    }
    const vbs = path.join(path.dirname(script), 'launch-widget.vbs')
    if (!fs.existsSync(vbs)) {
      logLaunch(`launch: launcher missing ${vbs}`)
      return
    }
    const root = proc.env?.SystemRoot || 'C:\\Windows'
    const wscript = path.join(root, 'System32', 'wscript.exe')
    const child = cp.spawn(wscript, [vbs], { detached: true, stdio: 'ignore', windowsHide: true })
    if (child && typeof child.on === 'function') child.on('error', () => {})
    if (child && typeof child.unref === 'function') child.unref()
    logLaunch(`launch: wscript pid=${child?.pid} vbs=${vbs}`)
  } catch (error) {
    logLaunch(`launch failed: ${String(error)}`)
  }
}

/* -------------------------------------------------------------------- entry */

/**
 * Plugin entry: wire the session/agent event listeners and the progress route.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  try {
    const store = storeFor(ctx)
    const listen = (name, handler) => {
      try {
        if (typeof ctx?.on === 'function') {
          ctx.on(name, (...args) => {
            try {
              handler(...args)
            } catch {
              /* never let a listener throw into the host */
            }
          })
        }
      } catch {
        /* an unavailable event bus is fine */
      }
    }

    listen('session/event', (session, event) => {
      let type = ''
      try {
        type = eventTypeOf(event)
        const data = eventDataOf(event)
        const seq = eventSeqOf(event)
        debugLog(
          `event ${type} turn=${data.turn ?? '-'} step=${data.step ?? '-'} seq=${seq ?? '-'}` +
            ` sid=${String(sessionIdOf(session) || '').slice(-6)}`,
        )
      } catch {
        /* ignore */
      }
      handleSessionEvent(store, session, event)
      // Push a fresh snapshot right away: waiting for the 800 ms heartbeat made
      // new steps/tools show up noticeably late on the desktop widget. The
      // scheduler coalesces bursts, so even chatty sessions cost at most one
      // extra write per ~60 ms. Turn boundaries skip the debounce entirely.
      schedulePublish(ctx, IMMEDIATE_EVENTS.has(type) ? 0 : 60)
    })
    listen('agent/status', (payload) => {
      handleAgentStatus(store, payload)
      schedulePublish(ctx, 0)
    })
    listen('agent/disposed', (payload) => handleAgentDisposed(store, payload))
    listen('session/disposed', (session) => handleSessionDisposed(store, session))

    startDesktopPublisher(ctx)
    if (typeof setTimeout === 'function') {
      const boot = setTimeout(() => {
        try {
          launchDesktopWidget()
        } catch {
          /* ignore */
        }
      }, 1500)
      if (boot && typeof boot.unref === 'function') boot.unref()
    } else {
      launchDesktopWidget()
    }
  } catch {
    /* keep loading even if event registration fails */
  }
  registerRoute(ctx)
}

export { PROGRESS_PATH, PLUGIN_VERSION }
