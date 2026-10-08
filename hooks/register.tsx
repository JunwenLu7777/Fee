import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionUsage, TurnUsage } from 'claude-code'

import type { HudActivity, HudDiff, HudGit, HudLimit, HudStats, HudTodo, HudTokens } from '../types'

const stats = atom({ plugin: 'hud', key: 'stats' } as const, null)
const modelId = atom({ plugin: 'hud', key: 'modelId' } as const, null)
const effort = atom({ plugin: 'hud', key: 'effort' } as const, null)
const git = atom({ plugin: 'hud', key: 'git' } as const, null)
const dir = atom({ plugin: 'hud', key: 'dir' } as const, null)
const activity = atom({ plugin: 'hud', key: 'activity' } as const, null)
const now = atom({ plugin: 'hud', key: 'now' } as const, null)
const isHidden = atom({ plugin: 'hud', key: 'isHidden' } as const, false)
const tokens = atom({ plugin: 'hud', key: 'tokens' } as const, null)
const diff = atom({ plugin: 'hud', key: 'diff' } as const, null)
const todos = atom({ plugin: 'hud', key: 'todos' } as const, null)
const agents = atom({ plugin: 'hud', key: 'agents' } as const, 0)
const fable = atom({ plugin: 'hud', key: 'fable' } as const, null)
const turns = atom({ plugin: 'hud', key: 'turns' } as const, null)
const version = atom({ plugin: 'hud', key: 'version' } as const, null)
// 本地时区相对 UTC 的分钟数，插件环境里的 Date 不一定是本机时区，启动时问一次 date
const tzOffset = atom({ plugin: 'hud', key: 'tzOffset' } as const, null)

const HIDDEN_KEY = 'isHidden'
// 引擎给插件的 rateLimits 只有 5h / 7d，Fable 的周额度得自己去 /usage 用的接口拿
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const FABLE_MIN_GAP_MS = 120_000
const FABLE_EVERY_MS = 300_000
// 这些工具跑完可能改了文件，跑完顺手刷新 git 状态
const MUTATING_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit'])
const SPINNER = ['◐', '◓', '◑', '◒']
const SEP = ' │ '

// ---------- 数据整理 ----------

const toLimit = (limits: readonly SessionRateLimit[], kind: string): HudLimit | null => {
  const found = limits.find(r => r.kind === kind)
  if (!found) {
    return null
  }
  const resetsAt = found.resetsAt ? Date.parse(found.resetsAt) : NaN

  return { percent: found.percentUsed, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
}

const toStats = (
  u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>,
  startedAt: number | null,
): HudStats => ({
  contextPercent: u.context.percent ?? null,
  contextTokens: u.context.tokens ?? null,
  contextWindow: u.context.window || null,
  costUsd: u.cost?.usd ?? null,
  startedAt,
  fiveHour: toLimit(u.rateLimits, 'five_hour'),
  sevenDay: toLimit(u.rateLimits, 'seven_day'),
})

type UsageLimit = { percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } | null } | null }

// limits[] 里按模型分的周额度，scope.model.display_name 是 Fable 的那条；有多条取占用最高的
const parseFable = (body: string): HudLimit | null => {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  const limits = (data as { limits?: unknown } | null)?.limits
  const found = (Array.isArray(limits) ? limits : []).flatMap((item: unknown) => {
    const l = (item ?? {}) as UsageLimit
    const name = l.scope?.model?.display_name

    return typeof name === 'string' && /fable/i.test(name) && typeof l.percent === 'number'
      ? [{ percent: l.percent, resetsAt: l.resets_at }]
      : []
  })
  if (found.length === 0) {
    return null
  }
  const top = found.reduce((a, b) => (b.percent > a.percent ? b : a))
  const resetsAt =
    typeof top.resetsAt === 'number'
      ? top.resetsAt * 1000
      : typeof top.resetsAt === 'string'
        ? Date.parse(top.resetsAt)
        : NaN

  return { percent: Math.round(top.percent), resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
}

// date +%z 的输出：+0800 → 480
const parseOffset = (out: string): number | null => {
  const m = out.trim().match(/^([+-])(\d{2})(\d{2})$/)

  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null
}

const parseGit = (out: string): HudGit | null => {
  let branch = ''
  let oid = ''
  let ahead = 0
  let behind = 0
  let changes = 0
  let untracked = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length)
    } else if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      ahead = Number(m?.[1] ?? 0)
      behind = Number(m?.[2] ?? 0)
    } else if (line.startsWith('? ')) {
      untracked += 1
    } else if (line !== '' && !line.startsWith('#')) {
      changes += 1
    }
  }
  if (branch === '(detached)') {
    branch = oid.slice(0, 7)
  }

  return branch ? { branch, changes, untracked, ahead, behind } : null
}

const addUsage = (t: HudTokens | null, u: TurnUsage): HudTokens => ({
  input: (t?.input ?? 0) + u.input_tokens,
  output: (t?.output ?? 0) + u.output_tokens,
  cacheRead: (t?.cacheRead ?? 0) + u.cache_read_input_tokens,
  cacheWrite: (t?.cacheWrite ?? 0) + u.cache_creation_input_tokens,
})

type Hunk = { lines?: unknown }

// Edit / Write 的结果里数 structuredPatch 的 +/- 行；新建文件没有 patch，按内容行数算
const countPatch = (result: Record<string, unknown>): HudDiff | null => {
  if (result.staged === true) {
    return null
  }
  const patch = Array.isArray(result.structuredPatch) ? (result.structuredPatch as Hunk[]) : []
  let added = 0
  let removed = 0
  for (const hunk of patch) {
    for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
      if (typeof line !== 'string') {
        continue
      }
      if (line.startsWith('+')) {
        added += 1
      } else if (line.startsWith('-')) {
        removed += 1
      }
    }
  }
  if (patch.length === 0 && result.type === 'create' && typeof result.content === 'string') {
    added = result.content.replace(/\n$/, '').split('\n').length
  }

  return added || removed ? { added, removed } : null
}

// 工具成功时的结果对象；被拒、报错或没有结果时为 null
const okResult = (done: unknown): Record<string, unknown> | null => {
  const r = done as { deny?: unknown; isError?: unknown; result?: unknown }
  if (r.deny !== undefined || r.isError === true) {
    return null
  }

  return r.result && typeof r.result === 'object' ? (r.result as Record<string, unknown>) : null
}

const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const

const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)

const todoStatus = (v: unknown): HudTodo['status'] | null => TODO_STATUSES.find(s => s === v) ?? null

const toTodos = (raw: unknown): HudTodo[] =>
  (Array.isArray(raw) ? raw : []).flatMap((item: unknown, i) => {
    const t = (item ?? {}) as Record<string, unknown>
    const status = todoStatus(t.status)

    return status ? [{ id: String(i), status, label: text(t.activeForm) ?? text(t.content) ?? '' }] : []
  })

const shortDir = (cwd: string) => {
  if (/^\/(Users|home)\/[^/]+\/?$/.test(cwd)) {
    return '~'
  }

  return cwd.split('/').filter(Boolean).pop() ?? '/'
}

const shortTool = (tool: string) => {
  const name = tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool

  return name.length > 16 ? `${name.slice(0, 15)}…` : name
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// claude-opus-5-5 → Opus 5.5，claude-haiku-4-5-20251001 → Haiku 4.5，带 [1m] 或窗口 ≥1M 的加上 1M
const prettyModel = (id: string, window: number | null) => {
  const isLong = /\[1m\]/i.test(id) || (window ?? 0) >= 1_000_000
  const base = id.replace(/\[1m\]/i, '')
  const m = base.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/)
  const family = m?.[1] ? capitalize(m[1]) : null
  const version = m?.[2] ? `${m[2]}${m[3] ? `.${m[3]}` : ''}` : ''
  const name = family ? `${family} ${version}` : base.replace(/^claude-/, '')

  return { full: isLong ? `${name} 1M` : name, short: family ?? name }
}

// ---------- 格式化 ----------

const formatTokens = (n: number) => {
  if (n >= 1_000_000) {
    return `${Math.round(n / 100_000) / 10}M`
  }
  if (n >= 10_000) {
    return `${Math.round(n / 1000)}k`
  }

  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`
}

// 本轮耗时：12s、3m4s、1h2m
const formatElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) {
    return `${s}s`
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m${s % 60}s`
  }

  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

// 会话时长、限额重置倒计时：42m、1h30m、3d4h
const formatSpan = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`
  }

  return hours % 24 ? `${Math.floor(hours / 24)}d${hours % 24}h` : `${Math.floor(hours / 24)}d`
}

const formatClock = (at: number, offsetMinutes: number) => {
  const d = new Date(at + offsetMinutes * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const levelColor = (percent: number, warn: number, danger: number) =>
  percent >= danger ? 'red' : percent >= warn ? 'yellow' : 'green'

const meter = (percent: number, cells: number) => {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))

  return `${'▰'.repeat(filled)}${'▱'.repeat(cells - filled)}`
}

// ---------- 排版：三行，每行按终端宽度逐级精简 ----------

type Piece = { text: string; color?: string; dim?: boolean; bold?: boolean }
type Variant = Piece[]
type Segment = { id: string; side: 'left' | 'right'; variants: Variant[] }

const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff)

const cellWidth = (s: string) => {
  let width = 0
  for (const ch of s) {
    width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  }

  return width
}

const clip = (s: string, max: number) => {
  if (cellWidth(s) <= max) {
    return s
  }
  let out = ''
  for (const ch of s) {
    if (cellWidth(out + ch) > max - 1) {
      break
    }
    out += ch
  }

  return `${out}…`
}

const groupWidth = (variants: Variant[]) =>
  variants.reduce(
    (width, v, i) => width + (i ? SEP.length : 0) + v.reduce((w, p) => w + cellWidth(p.text), 0),
    0,
  )

// degrade 是放不下时一级一级精简的顺序，靠前的先让步
const fit = (segments: Segment[], degrade: readonly string[], columns: number) => {
  const level = new Map<string, number>()
  const pick = (side: Segment['side']) =>
    segments
      .filter(s => s.side === side)
      .map(s => s.variants[Math.min(level.get(s.id) ?? 0, s.variants.length - 1)] ?? [])
      .filter(v => v.length > 0)
  const width = () => {
    const left = groupWidth(pick('left'))
    const right = groupWidth(pick('right'))

    return left + right + (left && right ? 2 : 0)
  }

  for (const id of degrade) {
    if (width() <= columns) {
      break
    }
    level.set(id, (level.get(id) ?? 0) + 1)
  }

  return { left: pick('left'), right: pick('right') }
}

// ---------- 各段内容 ----------

type View = {
  stats: HudStats | null
  modelId: string | null
  effort: string | null
  git: HudGit | null
  dir: string | null
  activity: HudActivity | null
  now: number
  tokens: HudTokens | null
  diff: HudDiff | null
  todos: HudTodo[] | null
  agents: number
  fable: HudLimit | null
  turns: number | null
  version: string | null
  tzOffset: number | null
}

const DOT: Piece = { text: ' · ', dim: true }

const modelSegment = ({ modelId: id, effort: level, stats: s }: View): Variant[] => {
  if (!id) {
    return [[]]
  }
  const { full, short } = prettyModel(id, s?.contextWindow ?? null)
  const icon: Piece = { text: '◆ ', color: 'magenta' }
  const name = (text: string): Piece => ({ text, color: 'magenta', bold: true })

  return [
    [icon, name(full), ...(level ? [{ text: ` · ${level}`, dim: true }] : [])],
    [icon, name(full)],
    [icon, name(short)],
  ]
}

const contextSegment = ({ stats: s }: View): Variant[] => {
  const percent = s?.contextPercent
  if (percent == null) {
    return [[]]
  }
  const color = levelColor(percent, 70, 85)
  const label: Piece = { text: 'ctx ', dim: true }
  const bar: Piece = { text: `${meter(percent, 10)} `, color }
  const value: Piece = { text: `${percent}%`, color }
  const used: Piece[] =
    s?.contextTokens != null && s.contextWindow != null
      ? [{ text: ` ${formatTokens(s.contextTokens)}/${formatTokens(s.contextWindow)}`, dim: true }]
      : []

  return [[label, bar, value, ...used], [label, bar, value], [label, value]]
}

const limitPieces = (
  label: string,
  limit: HudLimit,
  at: number,
  { bar, reset }: { bar: boolean; reset: boolean },
): Piece[] => {
  const color = levelColor(limit.percent, 50, 80)

  return [
    { text: `${label} `, dim: true },
    ...(bar ? [{ text: `${meter(limit.percent, 5)} `, color }] : []),
    { text: `${limit.percent}%`, color },
    ...(reset && limit.resetsAt != null && limit.resetsAt > at
      ? [{ text: ` ↻${formatSpan(limit.resetsAt - at)}`, dim: true }]
      : []),
  ]
}

const limitsSegment = ({ stats: s, now: at, fable: f }: View): Variant[] => {
  const windows = [
    s?.fiveHour ? { label: '5h', limit: s.fiveHour, showReset: true } : null,
    // 周限额只在快用完时才值得看倒计时
    s?.sevenDay ? { label: '7d', limit: s.sevenDay, showReset: s.sevenDay.percent >= 70 } : null,
    f ? { label: 'fable', limit: f, showReset: f.percent >= 70 } : null,
  ].filter(w => w !== null)
  if (windows.length === 0) {
    return [[]]
  }
  const join = (parts: Piece[][]) => parts.flatMap((p, i) => (i ? [DOT, ...p] : p))
  const all = (bar: boolean, withReset: boolean) =>
    join(windows.map(w => limitPieces(w.label, w.limit, at, { bar, reset: withReset && w.showReset })))
  const highest = windows.reduce((a, b) => (b.limit.percent > a.limit.percent ? b : a))

  return [
    all(true, true),
    all(false, true),
    all(false, false),
    limitPieces(highest.label, highest.limit, at, { bar: false, reset: false }),
    [],
  ]
}

const tokensSegment = ({ tokens: t }: View): Variant[] => {
  if (!t) {
    return [[]]
  }
  // in 算上缓存读写，是真正发给模型的输入量
  const total = t.input + t.cacheRead + t.cacheWrite
  const out: Piece[] = [
    { text: 'in ', dim: true },
    { text: formatTokens(total) },
    DOT,
    { text: 'out ', dim: true },
    { text: formatTokens(t.output) },
  ]
  if (total === 0) {
    return [out, out, []]
  }
  const hit = Math.round((t.cacheRead / total) * 100)
  const cache: Piece[] = [
    { text: 'cache ', dim: true },
    { text: `${hit}%`, color: hit >= 70 ? 'green' : hit >= 40 ? 'yellow' : 'red' },
  ]

  return [[...out, DOT, ...cache], cache, []]
}

// cost 是本会话累计（/cost 的数），括号里是本轮（或上一轮）花的；session 是从开会话到现在的时长
const costSegment = ({ stats: s, activity: a, now: at }: View): Variant[] => {
  const usd = s?.costUsd
  const cost: Piece[] = usd != null ? [{ text: 'cost ', dim: true }, { text: `$${usd.toFixed(2)}` }] : []
  const delta = usd != null && a?.costAtStart != null ? usd - a.costAtStart : 0
  const turn: Piece[] =
    delta >= 0.005 ? [{ text: ` (${a?.isRunning ? '本轮' : '上轮'} +${delta.toFixed(2)})`, dim: true }] : []
  const span = s?.startedAt != null && at > s.startedAt ? formatSpan(at - s.startedAt) : null
  const duration: Piece[] = span
    ? [...(cost.length ? [DOT] : []), { text: 'session ', dim: true }, { text: span }]
    : []

  return [[...cost, ...turn, ...duration], [...cost, ...duration], cost, []]
}

const gitSegment = ({ git: g, dir: d }: View): Variant[] => {
  const folder: Piece[] = d ? [{ text: d, color: 'blue', bold: true }] : []
  if (!g) {
    return [folder, []]
  }
  const branch: Piece = { text: `⎇ ${g.branch}`, color: 'cyan' }
  const changes: Piece[] = g.changes ? [{ text: ` ±${g.changes}`, color: 'yellow' }] : []
  const untracked: Piece[] = g.untracked ? [{ text: ` ?${g.untracked}`, color: 'yellow', dim: true }] : []
  const sync = `${g.ahead ? `↑${g.ahead}` : ''}${g.behind ? `↓${g.behind}` : ''}`
  const ab: Piece[] = sync ? [{ text: ` ${sync}`, color: 'cyan', dim: true }] : []
  const gap: Piece[] = folder.length ? [{ text: ' ' }] : []

  return [
    [...folder, ...gap, branch, ...changes, ...untracked, ...ab],
    [branch, ...changes, ...untracked, ...ab],
    [branch, ...changes],
    [branch],
    [],
  ]
}

const diffSegment = ({ diff: d }: View): Variant[] => {
  if (!d || (d.added === 0 && d.removed === 0)) {
    return [[]]
  }

  return [
    [
      { text: `+${formatTokens(d.added)}`, color: 'green' },
      { text: ' ' },
      { text: `-${formatTokens(d.removed)}`, color: 'red' },
    ],
    [],
  ]
}

const todosSegment = ({ todos: list }: View): Variant[] => {
  if (!list?.length) {
    return [[]]
  }
  const done = list.filter(t => t.status === 'completed').length
  const color = done === list.length ? 'green' : 'cyan'
  const count: Piece[] = [{ text: `✓ ${done}/${list.length}`, color }]
  const active = list.find(t => t.status === 'in_progress')
  const label: Piece[] = active ? [{ text: ` ${clip(active.label, 28)}`, dim: true }] : []

  return [[...count, ...label], count, []]
}

const agentsSegment = ({ agents: n }: View): Variant[] => {
  if (!n) {
    return [[]]
  }

  return [
    [{ text: `◇ ${n} agent${n > 1 ? 's' : ''}`, color: 'yellow' }],
    [{ text: `◇${n}`, color: 'yellow' }],
    [],
  ]
}

const turnSegment = ({ activity: a }: View): Variant[] => {
  if (!a) {
    return [[]]
  }
  const elapsed = formatElapsed(a.elapsedMs)
  const tools: Piece = { text: ` ⚒${a.tools}`, dim: true }
  if (!a.isRunning) {
    const done: Piece = { text: `上轮 ${elapsed}`, dim: true }

    return [[done, tools], [done, tools], [done], []]
  }
  const spin: Piece = {
    text: `${SPINNER[Math.floor(a.elapsedMs / 1000) % SPINNER.length]} `,
    color: 'yellow',
  }
  const tool: Piece[] = a.activeTool ? [{ text: `${a.activeTool} `, color: 'yellow', bold: true }] : []
  const time: Piece = { text: elapsed, color: 'yellow' }

  return [[spin, ...tool, time, tools], [spin, time, tools], [spin, time, tools], [spin, time]]
}

// 第几轮：本会话里发了几条消息
const turnsSegment = ({ turns: n }: View): Variant[] => (n ? [[{ text: `#${n}`, dim: true }], []] : [[]])

const clockSegment = ({ now: at, tzOffset: tz }: View): Variant[] => {
  if (!at) {
    return [[]]
  }
  const offset = tz ?? -new Date(at).getTimezoneOffset()

  return [[{ text: formatClock(at, offset) }], []]
}

const versionSegment = ({ version: v }: View): Variant[] => (v ? [[{ text: `v${v}`, dim: true }], []] : [[]])

type Row = { segments: (view: View) => Segment[]; degrade: readonly string[] }

const ROWS: Row[] = [
  // 第一行：模型、上下文和限额
  {
    segments: view => [
      { id: 'model', side: 'left', variants: modelSegment(view) },
      { id: 'context', side: 'left', variants: contextSegment(view) },
      { id: 'limits', side: 'left', variants: limitsSegment(view) },
    ],
    degrade: [
      'context', // 去掉 token 数
      'limits', // 去掉小进度条
      'limits', // 去掉重置倒计时
      'model', // 去掉 effort
      'limits', // 只留占用最高的那个窗口
      'context', // 进度条变成纯百分比
      'limits', // 去掉限额
      'model', // 模型只留系列名
    ],
  },
  // 第二行：token 和花费
  {
    segments: view => [
      { id: 'tokens', side: 'left', variants: tokensSegment(view) },
      { id: 'cost', side: 'left', variants: costSegment(view) },
    ],
    degrade: [
      'cost', // 去掉本轮花费
      'tokens', // 只留缓存命中率
      'cost', // 去掉会话时长
      'tokens', // 去掉 token 统计
      'cost', // 去掉花费
    ],
  },
  // 第三行：工作区和进度（目录、git、改动行数、待办、子 agent、本轮）
  {
    segments: view => [
      { id: 'git', side: 'left', variants: gitSegment(view) },
      { id: 'diff', side: 'left', variants: diffSegment(view) },
      { id: 'todos', side: 'left', variants: todosSegment(view) },
      { id: 'turns', side: 'right', variants: turnsSegment(view) },
      { id: 'agents', side: 'right', variants: agentsSegment(view) },
      { id: 'turn', side: 'right', variants: turnSegment(view) },
      { id: 'clock', side: 'right', variants: clockSegment(view) },
      { id: 'version', side: 'right', variants: versionSegment(view) },
    ],
    degrade: [
      'todos', // 去掉当前待办的文字
      'version', // 去掉版本号
      'git', // 去掉目录名
      'turn', // 去掉当前工具名
      'agents', // 子 agent 只留数字
      'turns', // 去掉第几轮
      'git', // 去掉未跟踪文件数和 ahead/behind
      'diff', // 去掉改动行数
      'turn', // 去掉工具次数
      'git', // 只留分支名
      'todos', // 去掉待办
      'agents', // 去掉子 agent
      'clock', // 去掉时间
      'git', // 去掉分支
      'turn', // 去掉本轮
    ],
  },
]

// ---------- 刷新 ----------

let isGitRefreshing = false

const refreshGit = async ($: EngineInterface) => {
  if (isGitRefreshing) {
    return
  }
  isGitRefreshing = true
  try {
    const ran = await $.process
      .run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], { timeoutMs: 3000 })
      .catch(() => null)
    const found = ran?.exitCode === 0 ? parseGit(ran.stdout) : null
    await update($, git, () => found)
  } finally {
    isGitRefreshing = false
  }
}

const refreshModel = async ($: EngineInterface) => {
  const id = await $.session.model()
  await update($, modelId, () => id)
}

// 时间、会话时长和倒计时都按分钟显示，分钟变了才写，免得每次都重画
const refreshNow = async ($: EngineInterface) => {
  const at = await $.clock.now()
  const shown = await read($, now)
  if (shown == null || Math.floor(at / 60_000) !== Math.floor(shown / 60_000)) {
    await update($, now, () => at)
  }
}

const refreshTurns = async ($: EngineInterface) => {
  const n = await $.session.turns().catch(() => null)
  await update($, turns, () => n)
}

const refreshVersion = async ($: EngineInterface) => {
  const v = await $.session.version().catch(() => null)
  await update($, version, () => (v ? (v.base ?? v.version) : null))
}

const refreshOffset = async ($: EngineInterface) => {
  const ran = await $.process.run(['date', '+%z'], { timeoutMs: 3000 }).catch(() => null)
  const found = ran?.exitCode === 0 ? parseOffset(ran.stdout) : null
  await update($, tzOffset, () => found)
}

// 只在数量变了时才写，免得每次轮询都重画
const refreshAgents = async ($: EngineInterface) => {
  const list = await $.agent.list().catch(() => null)
  if (!list) {
    return
  }
  const running = list.filter(a => a.status === 'running').length
  if (running !== (await read($, agents))) {
    await update($, agents, () => running)
  }
}

let isFableRefreshing = false
let fableFetchedAt = 0

// 只有订阅登录（OAuth）才有额度；拉失败就留着上一次的数，接口答了但没有 Fable 那条才清掉
const refreshFable = async ($: EngineInterface) => {
  const at = await $.clock.now()
  if (isFableRefreshing || (fableFetchedAt && at - fableFetchedAt < FABLE_MIN_GAP_MS)) {
    return
  }
  isFableRefreshing = true
  fableFetchedAt = at
  try {
    const auth = await $.session.authorize().catch(() => null)
    if (auth?.kind !== 'bearer') {
      return
    }
    const res = await $.http
      .fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
      .catch(() => null)
    if (res?.ok) {
      const found = parseFable(res.text)
      await update($, fable, () => found)
    }
  } finally {
    isFableRefreshing = false
  }
}

const settingsEffort = async ($: EngineInterface) => {
  const settings = await $.settings.read().catch(() => null)
  const env = settings?.env
  const fromEnv =
    env && typeof env === 'object' ? (env as Record<string, unknown>).CLAUDE_CODE_EFFORT_LEVEL : undefined
  const value = fromEnv ?? settings?.effortLevel

  return typeof value === 'string' && value !== '' ? value : null
}

// 工具成功后更新改动行数和待办；工具参数当普通对象逐项检查着读
const track = async (
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
) => {
  if (tool === 'Edit' || tool === 'Write') {
    const counted = countPatch(result)
    if (counted) {
      await update($, diff, d => ({
        added: (d?.added ?? 0) + counted.added,
        removed: (d?.removed ?? 0) + counted.removed,
      }))
    }
  } else if (tool === 'TodoWrite') {
    // TodoWrite 是每个 agent 自己的清单，只跟主对话的
    if (args.agentId == null) {
      const list = toTodos(args.todos)
      await update($, todos, () => list)
    }
  } else if (tool === 'TaskCreate') {
    const id = text((result.task as { id?: unknown } | undefined)?.id)
    if (id) {
      const added: HudTodo = { id, status: 'pending', label: text(args.activeForm) ?? text(args.subject) ?? '' }
      await update($, todos, list => [...(list ?? []), added])
    }
  } else if (tool === 'TaskUpdate') {
    const id = text(args.taskId)
    const isDeleted = args.status === 'deleted'
    const status = todoStatus(args.status)
    const label = text(args.activeForm) ?? text(args.subject)
    await update($, todos, list => {
      if (!list) {
        return list
      }

      return isDeleted
        ? list.filter(t => t.id !== id)
        : list.map(t => (t.id === id ? { ...t, status: status ?? t.status, label: label ?? t.label } : t))
    })
  }
}

const tick = async ($: EngineInterface) => {
  const current = await read($, activity)
  if (!current?.isRunning) {
    return
  }
  const at = await $.clock.now()
  await update($, activity, a => (a?.isRunning ? { ...a, elapsedMs: at - a.startedAt } : a))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'hud',
      description: '开关 bypass permissions 下方的 HUD',
      argumentHint: '[on|off]',
      immediate: true,
    })
    const stored = (await $.store.get(HIDDEN_KEY)) === true
    await update($, isHidden, () => stored)
    await update($, activity, a => (a ? { ...a, isRunning: false, activeTool: null } : a))
    $.clock.every(1000, () => void tick($))
    $.clock.every(3000, () => void refreshAgents($))
    $.clock.every(5000, () => void refreshNow($))
    $.clock.every(FABLE_EVERY_MS, () => void refreshFable($))

    const [usage, cwd, configured] = await Promise.all([
      $.session.usage(),
      $.session.cwd(),
      settingsEffort($),
    ])
    await update($, stats, () => toStats(usage, usage.startedAt))
    await update($, dir, () => shortDir(cwd))
    await update($, effort, current => current ?? configured)
    await refreshNow($)
    await refreshModel($)
    await refreshGit($)
    await refreshAgents($)
    await refreshTurns($)
    await refreshVersion($)
    await refreshOffset($)
    void refreshFable($)

    return started
  })

  on('turn.start', async ($, e, next) => {
    const [startedAt, s] = await Promise.all([$.clock.now(), read($, stats)])
    await update($, activity, () => ({
      turnId: e.turnId,
      startedAt,
      elapsedMs: 0,
      tools: 0,
      activeTool: null,
      isRunning: true,
      costAtStart: s?.costUsd ?? null,
    }))
    await refreshModel($)
    await refreshTurns($)

    return next(e)
  })

  // 每次请求模型时带着实际生效的 effort，/effort 改了这里就跟着变；子 agent 的请求不算
  on('turn.step', async function* ($, e, next) {
    if (e.agentId == null) {
      await update($, effort, () => (e.effort == null ? null : String(e.effort)))
    }

    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const name = shortTool(e.tool)
    await update($, activity, a => (a?.isRunning ? { ...a, tools: a.tools + 1, activeTool: name } : a))
    if (e.tool === 'Agent') {
      void refreshAgents($)
    }
    try {
      const done = await next(e)
      const result = okResult(done)
      if (result) {
        await track($, e.tool, e as unknown as Record<string, unknown>, result)
      }

      return done
    } finally {
      await update($, activity, a => (a?.activeTool === name ? { ...a, activeTool: null } : a))
      if (MUTATING_TOOLS.has(e.tool)) {
        void refreshGit($)
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.usage) {
      const used = e.usage
      await update($, tokens, t => addUsage(t, used))
    }
    // 子 agent 每跑完一次也算一个 turn.complete，不能把主对话的本轮当成结束了
    if (e.agentId != null) {
      void refreshAgents($)

      return done
    }
    const at = await $.clock.now()
    await update($, activity, a =>
      a ? { ...a, isRunning: false, activeTool: null, elapsedMs: at - a.startedAt } : a,
    )
    await refreshNow($)
    await refreshGit($)
    await refreshAgents($)
    void refreshFable($)

    return done
  })

  on('session.measure', async ($, e, next) => {
    await update($, stats, s => toStats(e, s?.startedAt ?? null))

    return next(e)
  })

  on('command.run', { command: 'hud' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: '用法：/hud 切换，/hud on 打开，/hud off 关闭' }
    }

    const hide = arg === '' ? !(await read($, isHidden)) : arg === 'off'
    await update($, isHidden, () => hide)
    await $.store.set(HIDDEN_KEY, hide)

    return { text: hide ? 'HUD 已关闭，输入 /hud 重新打开' : 'HUD 已打开' }
  })

  // 第一行照常是引擎自己的提示（⏵⏵ bypass permissions 等），HUD 另起三行画在它下面
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = await next(e)
    if (await read($, isHidden)) {
      return line
    }

    const { Box, Text } = $.ui.resolve(e)
    const [s, id, level, g, d, a, at, t, df, td, n, fb, tn, v, tz] = await Promise.all([
      read($, stats),
      read($, modelId),
      read($, effort),
      read($, git),
      read($, dir),
      read($, activity),
      read($, now),
      read($, tokens),
      read($, diff),
      read($, todos),
      read($, agents),
      read($, fable),
      read($, turns),
      read($, version),
      read($, tzOffset),
    ])
    const view: View = {
      stats: s,
      modelId: id,
      effort: level,
      git: g,
      dir: d,
      activity: a,
      now: at ?? 0,
      tokens: t,
      diff: df,
      todos: td,
      agents: n,
      fable: fb,
      turns: tn,
      version: v,
      tzOffset: tz,
    }
    const columns = Math.max(20, (e.viewport?.columns ?? 120) - 4)
    const rows = ROWS.map(row => fit(row.segments(view), row.degrade, columns)).filter(
      r => r.left.length > 0 || r.right.length > 0,
    )

    const draw = (groups: Variant[]) =>
      groups.flatMap((pieces, i) => [
        ...(i ? [<Text dimColor>{SEP}</Text>] : []),
        ...pieces.map(p => (
          <Text
            {...(p.color ? { color: p.color } : {})}
            {...(p.dim ? { dimColor: true } : {})}
            {...(p.bold ? { bold: true } : {})}
          >
            {p.text}
          </Text>
        )),
      ])

    // 引擎自己的那行不能放在带 width 的 Box 里，否则整棵树会被拒绝，外层只靠 column 拉伸
    return (
      <Box flexDirection="column">
        {line}
        {rows.map(({ left, right }) => (
          <Box width="100%">
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">{draw(left)}</Text>
            </Box>
            {right.length > 0 && (
              <Box flexShrink={0} marginLeft={2}>
                <Text wrap="truncate-end">{draw(right)}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
