import { atom, memberOf, read, update } from 'claude-code'
import type {
  EngineInterface,
  PluginOptions,
  Register,
  RenderElement,
  SessionRateLimit,
  SessionUsage,
  Timer,
  ToolCallResult,
  TurnUsage,
  UiPressArgument,
} from 'claude-code'

import type {
  HudActivity,
  HudDaily,
  HudWarm,
  HudDiff,
  HudFileEdit,
  HudGit,
  HudLimit,
  HudStats,
  HudTodo,
  HudTokens,
} from '../types'

import { cellWidth, clip, dayKey, formatClock, formatElapsed, formatSpan, formatTokens, formatWhen } from './format'
import { MIN_ELAPSED_SHARE, alertText, limitWindows } from './forecast'
import type { LimitWindow } from './forecast'
import { SNAPSHOT_SCRIPT, parseNumstat, parseSnapshot } from './snapshot'
import type { Snapshot } from './snapshot'
import { parseDaily, parseStored } from './spend'
import { partsOf } from './context'
import { drawChanges } from './changes'
import { choiceText, parseChoices } from './choices'
import {
  CACHE_TTL_LONG_MS,
  CACHE_TTL_SHORT_MS,
  EDIT_TOOLS,
  LOOP_EDITS,
  LOOP_FAILS,
  SHELL_TOOLS,
  addUsage,
  bump,
  cacheMissOf,
  callLabel,
  compactForecast,
  costSince,
  countPatch,
  defaultView,
  drop,
  emptyReceipt,
  isFailed,
  matchTurn,
  promptOf,
  pushCall,
  pushTurn,
  relativePath,
  sumLines,
  toTurn,
  withAgentRun,
  withAgentTool,
  withCacheMiss,
  withCommand,
  withEdit,
  withLastContext,
  withLastCost,
  withSpawn,
  withStatuses,
  withTokens,
  withToolTime,
} from './ledger'
import type { CompactForecast } from './ledger'
import { drawDetails, receiptPieces } from './details'

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
const answered = { plugin: 'hud', key: 'answered' } as const
const copiedAt = atom({ plugin: 'hud', key: 'copiedAt' } as const, null)
const turnLog = atom({ plugin: 'hud', key: 'turnLog' } as const, [])
const toolStats = atom({ plugin: 'hud', key: 'toolStats' } as const, [])
const agentLog = atom({ plugin: 'hud', key: 'agentLog' } as const, [])
const isExpanded = atom({ plugin: 'hud', key: 'isExpanded' } as const, false)
const detailsView = atom({ plugin: 'hud', key: 'detailsView' } as const, defaultView())
const toolCalls = atom({ plugin: 'hud', key: 'toolCalls' } as const, [])
const warnedLimits = atom({ plugin: 'hud', key: 'warnedLimits' } as const, {})
const baseTree = atom({ plugin: 'hud', key: 'baseTree' } as const, null)
const daily = atom({ plugin: 'hud', key: 'daily' } as const, null)
const compactAt = atom({ plugin: 'hud', key: 'compactAt' } as const, null)
const contextParts = atom({ plugin: 'hud', key: 'contextParts' } as const, null)
const sessionFiles = atom({ plugin: 'hud', key: 'sessionFiles' } as const, [])
const lastTree = atom({ plugin: 'hud', key: 'lastTree' } as const, null)
const changesView = atom({ plugin: 'hud', key: 'changesView' } as const, { path: null, page: 0, turn: null })
const fileDiff = atom({ plugin: 'hud', key: 'fileDiff' } as const, null)
// 改动侧边栏摆出来了没有：没摆出来时 HUD 右边才放「◂ 改动」；以引擎记的为准，隔几秒对一次
const isChangesUp = atom({ plugin: 'hud', key: 'isChangesUp' } as const, false)
const lastStep = atom({ plugin: 'hud', key: 'lastStep' } as const, null)
const choices = atom({ plugin: 'hud', key: 'choices' } as const, null)
const picked = atom({ plugin: 'hud', key: 'picked' } as const, [])
const warm = atom({ plugin: 'hud', key: 'warm' } as const, null)

const HIDDEN_KEY = 'isHidden'
// 改动侧边栏：你亲手关掉过就记下，下次启动不再自己打开
const CHANGES_PANE = 'hud-changes'
const CHANGES_KEY = 'changesPane'
// 上一次 ccusage 算出来的每天花费，下次启动先拿它画
const DAILY_KEY = 'daily'
// 引擎给插件的 rateLimits 只有 5h / 7d，Fable 的周额度得自己去 /usage 用的接口拿
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const FABLE_MIN_GAP_MS = 120_000
const FABLE_EVERY_MS = 300_000
const COPIED_MS = 1500
// 额度、原地打转这些提醒停留的时间
const ALERT_MS = 8000
// 这些工具跑完可能改了文件，跑完顺手刷新 git 状态和改动行数
const MUTATING_TOOLS = new Set([...EDIT_TOOLS, ...SHELL_TOOLS])
const SPINNER = ['◐', '◓', '◑', '◒']
const SEP = ' │ '

// ---------- /config 里能改的几个门槛（plugin.json 的 userConfig），没设就用默认值 ----------

type Config = {
  // 同一条命令连着失败几次、同一个文件一轮里改几次提醒原地打转；0 不提醒
  loopFails: number
  loopEdits: number
  // 额度照现在的速度会提前用完时弹不弹提示（HUD 上照样写）
  limitAlert: boolean
  // 额度窗口过了百分之几才开始预测
  forecastAfter: number
  // 还能撑几轮以内才在 HUD 上写「约 N 轮后压缩」；0 不写
  compactTurns: number
  // HUD 最后一行右边的常用指令，点一下就发出去
  quickPrompts: string[]
  // 离开时最多续几次缓存（订阅账号每次续 1 小时）；0 不续
  keepWarmTimes: number
}

const DEFAULT_CONFIG: Config = {
  loopFails: LOOP_FAILS,
  loopEdits: LOOP_EDITS,
  limitAlert: true,
  forecastAfter: MIN_ELAPSED_SHARE * 100,
  compactTurns: 10,
  quickPrompts: ['提交+push', '接下来做什么'],
  keepWarmTimes: 3,
}

let config = DEFAULT_CONFIG
const QUICK_MAX = 6

// 设置里存的可能是数字也可能是字符串；不是数就用默认值，超出范围的截到范围里
const numberOption = (v: unknown, fallback: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN

  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : fallback
}

const readConfig = (o: PluginOptions): Config => ({
  loopFails: numberOption(o.loopFails, DEFAULT_CONFIG.loopFails, 100),
  loopEdits: numberOption(o.loopEdits, DEFAULT_CONFIG.loopEdits, 1000),
  limitAlert: typeof o.limitAlert === 'boolean' ? o.limitAlert : DEFAULT_CONFIG.limitAlert,
  forecastAfter: numberOption(o.forecastAfter, DEFAULT_CONFIG.forecastAfter, 90),
  compactTurns: numberOption(o.compactTurns, DEFAULT_CONFIG.compactTurns, 100),
  // 用 | 隔开；留空就不放
  quickPrompts:
    typeof o.quickPrompts === 'string'
      ? o.quickPrompts
          .split('|')
          .map(t => t.trim())
          .filter(Boolean)
          .slice(0, QUICK_MAX)
      : DEFAULT_CONFIG.quickPrompts,
  keepWarmTimes: numberOption(o.keepWarmTimes, DEFAULT_CONFIG.keepWarmTimes, 10),
})

const forecastShare = () => config.forecastAfter / 100

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

// FNV-1a 加上长度，只用来认出同一段回复
const hashText = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }

  return `${s.length}:${(h >>> 0).toString(36)}`
}

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

const levelColor = (percent: number, warn: number, danger: number) =>
  percent >= danger ? 'red' : percent >= warn ? 'yellow' : 'green'

const SEVERITY = ['green', 'yellow', 'red']

// 两个颜色里更严重的那个
const worse = (a: string, b: string) => (SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b)

// 一格都填不满的条只占地方，不画
const meter = (percent: number, cells: number) => {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))

  return filled ? `${'▰'.repeat(filled)}${'▱'.repeat(cells - filled)}` : null
}

// ---------- 排版：宽窗口两行、窄窗口三行，每行再按终端宽度逐级精简 ----------

type Piece = { text: string; color?: string; dim?: boolean; bold?: boolean }
type Variant = Piece[]
type Segment = { id: string; variants: Variant[] }

const groupWidth = (variants: Variant[]) =>
  variants.reduce(
    (width, v, i) => width + (i ? SEP.length : 0) + v.reduce((w, p) => w + cellWidth(p.text), 0),
    0,
  )

// degrade 是放不下时一级一级精简的顺序，靠前的先让步
const fit = (segments: Segment[], degrade: readonly string[], columns: number) => {
  const level = new Map<string, number>()
  const pick = () =>
    segments
      .map(s => s.variants[Math.min(level.get(s.id) ?? 0, s.variants.length - 1)] ?? [])
      .filter(v => v.length > 0)

  for (const id of degrade) {
    if (groupWidth(pick()) <= columns) {
      break
    }
    level.set(id, (level.get(id) ?? 0) + 1)
  }

  return pick()
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
  // 照最近几轮的涨法，还能撑几轮到自动压缩
  compact: CompactForecast | null
  // 离开时续缓存续了几次
  warm: HudWarm | null
}

const DOT: Piece = { text: ' · ', dim: true }

// 约 4 轮后压缩：一轮以内标红，三轮以内标黄；还能撑很多轮的不占地方（几轮以内才写，/config 里能改）
const compactPieces = (c: CompactForecast | null): Piece[] => {
  if (!c || config.compactTurns === 0 || c.turnsLeft > config.compactTurns) {
    return []
  }
  const tone = c.turnsLeft <= 1 ? { color: 'red' } : c.turnsLeft <= 3 ? { color: 'yellow' } : { dim: true }

  return [{ text: c.turnsLeft === 0 ? ' 快压缩了' : ` 约${c.turnsLeft}轮后压缩`, ...tone }]
}

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

const contextSegment = ({ stats: s, compact: c }: View): Variant[] => {
  const percent = s?.contextPercent
  if (percent == null) {
    return [[]]
  }
  const soon = compactPieces(c)
  const color = levelColor(percent, 70, 85)
  const label: Piece = { text: 'ctx ', dim: true }
  const shape = meter(percent, 10)
  const bar: Piece[] = shape ? [{ text: `${shape} `, color }] : []
  const value: Piece = { text: `${percent}%`, color }
  const used: Piece[] =
    s?.contextTokens != null && s.contextWindow != null
      ? [{ text: ` ${formatTokens(s.contextTokens)}/${formatTokens(s.contextWindow)}`, dim: true }]
      : []

  return [
    [label, ...bar, value, ...used, ...soon],
    [label, ...bar, value, ...soon],
    [label, value, ...soon],
  ]
}

// 照现在的速度重置前就会用完的，百分比至少变黄，后面跟上约几点用完；快到了标红
const limitPieces = (
  w: LimitWindow,
  at: number,
  offset: number,
  { bar, reset }: { bar: boolean; reset: boolean },
): Piece[] => {
  const { limit, forecast } = w
  const warn = forecast ? (forecast.isUrgent ? 'red' : 'yellow') : 'green'
  const color = worse(levelColor(limit.percent, 50, 80), warn)
  const shape = bar ? meter(limit.percent, 5) : null

  return [
    { text: `${w.label} `, dim: true },
    ...(shape ? [{ text: `${shape} `, color }] : []),
    { text: `${limit.percent}%`, color },
    ...(reset && limit.resetsAt != null && limit.resetsAt > at
      ? [{ text: ` ↻${formatSpan(limit.resetsAt - at)}`, dim: true }]
      : []),
    ...(forecast ? [{ text: ` 约${formatWhen(forecast.runOutAt, at, offset)}用完`, color: warn }] : []),
  ]
}

// 插件环境里的 Date 不一定是本机时区，优先用启动时问到的偏移
const offsetOf = (tz: number | null, at: number) => tz ?? -new Date(at).getTimezoneOffset()

const limitsSegment = ({ stats: s, now: at, fable: f, tzOffset: tz }: View): Variant[] => {
  const windows = limitWindows(s, f, at, forecastShare()).map(w => ({
    ...w,
    // 周限额只在快用完、或者照现在的速度会提前用完时才值得看倒计时
    showReset: w.label === '5h' || w.limit.percent >= 70 || w.forecast != null,
  }))
  if (windows.length === 0) {
    return [[]]
  }
  const offset = offsetOf(tz, at)
  const join = (parts: Piece[][]) => parts.flatMap((p, i) => (i ? [DOT, ...p] : p))
  const all = (bar: boolean, withReset: boolean) =>
    join(windows.map(w => limitPieces(w, at, offset, { bar, reset: withReset && w.showReset })))
  // 只放得下一个时：有会提前用完的，留最先用完的那个；没有就留占用最高的
  const soonest = windows
    .flatMap(w => (w.forecast ? [{ w, runOutAt: w.forecast.runOutAt }] : []))
    .sort((a, b) => a.runOutAt - b.runOutAt)[0]?.w
  const highest = soonest ?? windows.reduce((a, b) => (b.limit.percent > a.limit.percent ? b : a))

  return [
    all(true, true),
    all(false, true),
    all(false, false),
    limitPieces(highest, at, offset, { bar: false, reset: false }),
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

// 你离开时续过缓存：缓存已续 1/3；这一轮在跑、还没续过时不写
const warmSegment = ({ warm: w, activity: a }: View): Variant[] =>
  w && w.refreshes > 0 && !a?.isRunning
    ? [[{ text: `缓存已续 ${w.refreshes}/${Math.max(w.refreshes, config.keepWarmTimes)}`, dim: true }], []]
    : [[]]

// 第几轮：本会话里发了几条消息
const turnsSegment = ({ turns: n }: View): Variant[] => (n ? [[{ text: `#${n}`, dim: true }], []] : [[]])

const clockSegment = ({ now: at, tzOffset: tz }: View): Variant[] => {
  if (!at) {
    return [[]]
  }
  return [[{ text: formatClock(at, offsetOf(tz, at)) }], []]
}

const versionSegment = ({ version: v }: View): Variant[] => (v ? [[{ text: `v${v}`, dim: true }], []] : [[]])

type Row = { segments: (view: View) => Segment[]; degrade: readonly string[] }

// 模型、上下文和限额
const RESOURCES: Row = {
  segments: view => [
    { id: 'model', variants: modelSegment(view) },
    { id: 'context', variants: contextSegment(view) },
    { id: 'limits', variants: limitsSegment(view) },
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
}

// token 和花费
const SPEND: Row = {
  segments: view => [
    { id: 'tokens', variants: tokensSegment(view) },
    { id: 'cost', variants: costSegment(view) },
  ],
  degrade: [
    'cost', // 去掉本轮花费
    'tokens', // 只留缓存命中率
    'cost', // 去掉会话时长
    'tokens', // 去掉 token 统计
    'cost', // 去掉花费
  ],
}

// 两行时 token 和花费接在模型那行后面，放不下先让细节（本轮花费、in/out、上下文 token 数）
const RESOURCES_AND_SPEND: Row = {
  segments: view => [...RESOURCES.segments(view), ...SPEND.segments(view)],
  degrade: [
    'cost', // 去掉本轮花费
    'tokens', // 只留缓存命中率
    'context', // 去掉 token 数
    'limits', // 去掉小进度条
    'limits', // 去掉重置倒计时
    'cost', // 去掉会话时长
    'tokens', // 去掉 token 统计
    'model', // 去掉 effort
    'limits', // 只留占用最高的那个窗口
    'context', // 进度条变成纯百分比
    'limits', // 去掉限额
    'cost', // 去掉花费
    'model', // 模型只留系列名
  ],
}

// 工作区和进度（目录、git、改动行数、待办），接着第几轮、子 agent、本轮、时间、版本
const WORKSPACE: Row = {
  segments: view => [
    { id: 'git', variants: gitSegment(view) },
    { id: 'diff', variants: diffSegment(view) },
    { id: 'todos', variants: todosSegment(view) },
    { id: 'turns', variants: turnsSegment(view) },
    { id: 'agents', variants: agentsSegment(view) },
    { id: 'turn', variants: turnSegment(view) },
    { id: 'warm', variants: warmSegment(view) },
    { id: 'clock', variants: clockSegment(view) },
    { id: 'version', variants: versionSegment(view) },
  ],
  degrade: [
    'todos', // 去掉当前待办的文字
    'warm', // 去掉续缓存的次数
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
}

// 窗口至少这么宽（列数）就画两行；窄了拆成三行，每行能多放些细节。
// 只看窗口宽度、不看内容长短，免得每轮花费一变 HUD 就在两行三行之间跳
const TWO_ROWS_MIN_COLUMNS = 150

const layout = (columns: number): Row[] =>
  columns >= TWO_ROWS_MIN_COLUMNS ? [RESOURCES_AND_SPEND, WORKSPACE] : [RESOURCES, SPEND, WORKSPACE]

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

// ---------- 改动行数：git 快照对比 ----------

// 拍快照、比两棵树一个接一个来，免得同时跑一堆 git
let gitQueue: Promise<unknown> = Promise.resolve()

const serially = <T,>(work: () => Promise<T>): Promise<T> => {
  const run = gitQueue.then(work, work)
  gitQueue = run.catch(() => undefined)

  return run
}

// 大仓库拍一次快照超时（或者没有 sh）就不再拍，小票退回按 Edit / Write 算；重新加载后再试
let isSnapshotOff = false
const SNAPSHOT_TIMEOUT_MS = 5000

const takeSnapshot = ($: EngineInterface): Promise<Snapshot | null> =>
  isSnapshotOff
    ? Promise.resolve(null)
    : serially(async () => {
        const ran = await $.process
          .run(['sh', '-c', SNAPSHOT_SCRIPT], { timeoutMs: SNAPSHOT_TIMEOUT_MS })
          .catch(() => {
            isSnapshotOff = true

            return null
          })

        return ran?.exitCode === 0 ? parseSnapshot(ran.stdout) : null
      })

// 从 from 这棵树到快照 to，改了哪些文件；比不了时为 null
const diffTrees = ($: EngineInterface, from: string, to: Snapshot) =>
  from === to.tree
    ? Promise.resolve([])
    : serially(async () => {
        const ran = await $.process
          .run(['git', 'diff', '--numstat', '-z', '-M', from, to.tree], {
            cwd: to.root,
            timeoutMs: SNAPSHOT_TIMEOUT_MS,
          })
          .catch(() => null)

        return ran?.exitCode === 0 ? parseNumstat(ran.stdout, to.prefix) : null
      })

// 会话开始时拍一张，HUD 上的 +N -M 是从这时起净改的；热重载时已经有了就不再拍
const initBaseline = async ($: EngineInterface) => {
  if (await read($, baseTree)) {
    return
  }
  const snap = await takeSnapshot($)
  if (snap) {
    await update($, baseTree, current => current ?? snap.tree)
  }
}

// 现在的工作区和会话开始时、这一轮开始时各比一下：HUD 上的 +N -M、这一轮小票里改的文件都换成准的
const measureChanges = async ($: EngineInterface) => {
  const [base, a] = await Promise.all([read($, baseTree), read($, activity)])
  const turnBase = a?.isRunning ? (a.treeAtStart ?? null) : null
  if (!base && !turnBase) {
    return
  }
  const snap = await takeSnapshot($)
  if (!snap) {
    return
  }
  if (base) {
    const files = await diffTrees($, base, snap)
    if (files) {
      await update($, diff, () => sumLines(files))
      await update($, sessionFiles, () => [...files].sort((x, y) => x.path.localeCompare(y.path)))
    }
  }
  // 小票里改的文件和比出它们的那张快照一起记，侧边栏按轮看时比的就是这两张
  if (a && turnBase) {
    const files = await diffTrees($, turnBase, snap)
    if (files) {
      await update($, activity, x =>
        x?.isRunning && x.turnId === a.turnId ? { ...x, receipt: { ...x.receipt, files }, treeAtEnd: snap.tree } : x,
      )
    }
  }
  const previous = await read($, lastTree)
  await update($, lastTree, () => snap.tree)
  // 工作区变了，侧边栏里点开的那个文件重新读
  if (previous !== snap.tree && (await read($, changesView)).path) {
    await loadFileDiff($)
  }
}

// 工具跑完一个比一次；正在比时又来了就排一次，排着的那次会看到最新的样子
let changesRun: Promise<void> = Promise.resolve()
let isChangesQueued = false

const refreshChanges = ($: EngineInterface) => {
  if (!isChangesQueued) {
    isChangesQueued = true
    changesRun = changesRun
      .then(() => {
        isChangesQueued = false

        return measureChanges($)
      })
      .catch(() => undefined)
  }

  return changesRun
}

// 侧边栏看的是哪一段：整个会话（会话开始 → 最近一张快照），或者某一轮（那一轮开始 → 结束，还在跑的到最近一张）
type ChangesRange = {
  from: string | null
  to: string | null
  files: readonly HudFileEdit[]
  // 按轮看时是哪一轮；看整个会话、或者那一轮已经不在记录里了，为 null
  turn: { id: string; label: string; isRunning: boolean } | null
}

const turnLabel = (index: number | null) => (index != null ? `第 ${index} 轮` : '那一轮')

const rangeOf = async ($: EngineInterface): Promise<ChangesRange> => {
  const [view, base, last, files, a, log] = await Promise.all([
    read($, changesView),
    read($, baseTree),
    read($, lastTree),
    read($, sessionFiles),
    read($, activity),
    read($, turnLog),
  ])
  // 旧版本存的没有 turn
  const id = view.turn ?? null
  if (id && a?.isRunning && a.turnId === id) {
    return {
      from: a.treeAtStart,
      to: a.treeAtEnd ?? last,
      files: a.receipt.files,
      turn: { id, label: turnLabel(a.index), isRunning: true },
    }
  }
  const t = id ? log.find(x => x.turnId === id) : undefined
  if (id && t) {
    return {
      from: t.treeAtStart ?? null,
      to: t.treeAtEnd ?? null,
      files: t.receipt.files,
      turn: { id, label: turnLabel(t.index), isRunning: false },
    }
  }

  return { from: base, to: last, files, turn: null }
}

// 侧边栏里点开的文件：这一段两张快照之间改了什么。只留改动本身（@@ 起），太长的截掉
const FILE_DIFF_MAX = 400

const patchLines = (out: string) => {
  const lines = out.split('\n')
  const start = lines.findIndex(l => l.startsWith('@@') || l.startsWith('Binary files'))

  return start < 0 ? [] : lines.slice(start).filter((l, i, all) => !(i === all.length - 1 && l === ''))
}

// 没拍到快照的（这个版本之前记的轮次）不读，侧边栏直接说看不了；git 读不出来（快照被清理了）记下来，别当成没改
const loadFileDiff = async ($: EngineInterface) => {
  const [view, { from, to }] = await Promise.all([read($, changesView), rangeOf($)])
  const path = view.path
  if (!path || !from || !to) {
    await update($, fileDiff, () => null)

    return
  }
  const ran = await serially(() =>
    $.process
      .run(['git', 'diff', '--no-color', '--no-ext-diff', '-U3', from, to, '--', path], { timeoutMs: SNAPSHOT_TIMEOUT_MS })
      .catch(() => null),
  )
  const isMissing = ran?.exitCode !== 0
  const lines = ran && !isMissing ? patchLines(ran.stdout) : []
  const kept = lines.slice(0, FILE_DIFF_MAX)
  const before = await read($, fileDiff)
  await update($, fileDiff, () => ({ path, base: from, tree: to, lines: kept, isCut: lines.length > FILE_DIFF_MAX, isMissing }))
  // 这一轮又改了它、改动变长变短了，翻到的页就不对了，回到第一页
  if (before?.path === path && before.base === from && before.lines.length !== kept.length) {
    await update($, changesView, v => (v.path === path ? { ...v, page: 0 } : v))
  }
}

// 点一个文件看它的改动，再点一下收起
const pickFile = async ($: EngineInterface, path: string) => {
  const view = await update($, changesView, v => ({ ...v, path: v.path === path ? null : path, page: 0 }))
  if (view.path) {
    await loadFileDiff($)
  }
}

// 换成看某一轮（null 是整个会话）；那一轮只改了一个文件就直接点开它
const showScope = async ($: EngineInterface, turnId: string | null) => {
  await update($, changesView, () => ({ path: null, page: 0, turn: turnId }))
  const range = await rangeOf($)
  const only = range.turn && range.files.length === 1 ? (range.files[0]?.path ?? null) : null
  if (only) {
    await update($, changesView, v => ({ ...v, path: only }))
    await loadFileDiff($)
  }
}

// 侧边栏开着、而且摆出来了（没摆出来的是终端太窄、在等着）。终端拉宽后才摆出来的、热重载前就开着的都靠这个对上
const syncChanges = async ($: EngineInterface) => {
  const panes = await $.ui.panes().catch(() => null)
  if (!panes) {
    return
  }
  const isUp = panes.some(p => p.id === CHANGES_PANE && p.isPlaced)
  if (isUp !== (await read($, isChangesUp))) {
    await update($, isChangesUp, () => isUp)
  }
}

// 自己打开（启动时）：终端够宽才摆出来；你亲手关过就不再自己开。热重载时侧边栏还开着，不用再开
const autoOpenChanges = async ($: EngineInterface) => {
  const isOpen = (await $.ui.panes().catch(() => [])).some(p => p.id === CHANGES_PANE)
  if (!isOpen && (await read($, baseTree)) && (await $.store.get(CHANGES_KEY)) !== 'closed') {
    await $.ui.open({ id: CHANGES_PANE, title: '改动' })
  }
  await syncChanges($)
}

// 从明细或者 HUD 右边的「◂ 改动」点开：多窄都摆出来，以后启动也照常自己开。
// 从明细里某一轮点开的，侧边栏换成看那一轮；HUD 上点开的照原来看的
const openChanges = async ($: EngineInterface, turnId?: string) => {
  if (turnId !== undefined) {
    await showScope($, turnId)
  }
  await $.store.set(CHANGES_KEY, 'open')
  const opened = await $.ui.open({ id: CHANGES_PANE, title: '改动' })
  await update($, isChangesUp, () => opened.isPlaced)
}

// 上下文里装了什么、到多少自动压缩：照 /context 的算法在本地估，不发请求。
// 每轮跑完估一次；展开明细时隔了一分钟以上也估一次；点「刷新」马上估
const CONTEXT_EVERY_MS = 60_000
let isContextRefreshing = false

const refreshContext = async ($: EngineInterface, force = false) => {
  const [at, current] = await Promise.all([$.clock.now(), read($, contextParts)])
  if (isContextRefreshing || (!force && current && at - current.at < CONTEXT_EVERY_MS)) {
    return
  }
  isContextRefreshing = true
  try {
    const b = (await $.session.usage({ breakdown: 'summary' }).catch(() => null))?.context.breakdown
    if (b) {
      await update($, compactAt, () => (b.isAutoCompactEnabled && b.autoCompactThreshold ? b.autoCompactThreshold : null))
      await update($, contextParts, () => partsOf(b, at, cwdPath))
    }
  } finally {
    isContextRefreshing = false
  }
}

// 换了模型，上下文窗口可能跟着变，自动压缩的点重新估一次
const refreshModel = async ($: EngineInterface) => {
  const id = await $.session.model()
  const previous = await read($, modelId)
  await update($, modelId, () => id)
  if (id !== previous) {
    await refreshContext($, true)
  }
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

// 只在数量或状态变了时才写，免得每次轮询都重画
const refreshAgents = async ($: EngineInterface) => {
  const list = await $.agent.list().catch(() => null)
  if (!list) {
    return
  }
  const running = list.filter(a => a.status === 'running').length
  if (running !== (await read($, agents))) {
    await update($, agents, () => running)
  }
  const [at, log] = await Promise.all([$.clock.now(), read($, agentLog)])
  if (withStatuses(log, list, at) !== log) {
    await update($, agentLog, current => withStatuses(current, list, at))
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
      await checkLimits($)
    }
  } finally {
    isFableRefreshing = false
  }
}

// 同一个额度窗口只提醒一次；重置时间差一小时以内都算同一个窗口
const isSameWindow = (warned: number | undefined, resetsAt: number) =>
  warned != null && Math.abs(warned - resetsAt) < 3_600_000

// 照现在的速度重置前就会用完时弹一次提示
const checkLimits = async ($: EngineInterface) => {
  const [s, f, tz, warned, at] = await Promise.all([
    read($, stats),
    read($, fable),
    read($, tzOffset),
    read($, warnedLimits),
    $.clock.now(),
  ])
  if (!config.limitAlert) {
    return
  }
  for (const w of limitWindows(s, f, at, forecastShare())) {
    const resetsAt = w.limit.resetsAt
    if (!w.forecast || resetsAt == null || isSameWindow(warned[w.label], resetsAt)) {
      continue
    }
    $.ui.toast(alertText(w, at, offsetOf(tz, at)), { timeoutMs: ALERT_MS })
    await update($, warnedLimits, list => ({ ...list, [w.label]: resetsAt }))
  }
}

// ---------- 每天花费：ccusage ----------

// ccusage 要读完本机所有会话的记录，几秒到十几秒；隔这么久才再算一次，点「刷新」不受限
const DAILY_EVERY_MS = 15 * 60_000
const DAILY_DAYS = 30
const DAILY_TIMEOUT_MS = 120_000
const DAY_MS = 86_400_000
let isDailyRunning = false
let dailyTriedAt = 0

const emptyDaily = (): HudDaily => ({ days: [], projects: [], fetchedAt: null, error: null, isRunning: false })

// 没装 ccusage 时 nice 报「No such file or directory」、退出码 127
const dailyError = (ran: { exitCode: number; stderr: string } | null) => {
  if (!ran) {
    return 'ccusage 跑太久没算完'
  }
  if (ran.exitCode === 127 || /No such file|not found/i.test(ran.stderr)) {
    return 'missing'
  }
  const first = ran.stderr.trim().split('\n')[0] ?? ''

  return first ? clip(first, 80) : `ccusage 出错，退出码 ${ran.exitCode}`
}

// 用 ccusage 算最近 30 天每天花了多少（本机所有会话）；没装、出错都留着上一次的数
const refreshDaily = async ($: EngineInterface, force = false) => {
  const [at, current, tz] = await Promise.all([$.clock.now(), read($, daily), read($, tzOffset)])
  if (isDailyRunning) {
    return
  }
  if (!force) {
    const last = Math.max(dailyTriedAt, current?.fetchedAt ?? 0)
    if (last && at - last < DAILY_EVERY_MS) {
      return
    }
    // 同时开着几个会话时，别的会话刚算过就直接拿它存下的
    const stored = parseStored(await $.store.get(DAILY_KEY).catch(() => null))
    if (stored && at - stored.fetchedAt < DAILY_EVERY_MS && stored.fetchedAt > (current?.fetchedAt ?? 0)) {
      await update($, daily, d => ({ ...(d ?? emptyDaily()), ...stored, error: null }))

      return
    }
  }
  isDailyRunning = true
  dailyTriedAt = at
  try {
    await update($, daily, d => ({ ...(d ?? emptyDaily()), isRunning: true }))
    const since = dayKey(at - (DAILY_DAYS - 1) * DAY_MS, offsetOf(tz, at)).replace(/-/g, '')
    // ccusage 很吃 CPU，降低优先级跑，别和手头的活抢；带上 --instances 一次拿到按项目分的
    const ran = await $.process
      .run(['nice', '-n', '10', 'ccusage', 'daily', '--json', '--instances', '--since', since], {
        timeoutMs: DAILY_TIMEOUT_MS,
      })
      .catch(() => null)
    const found = ran?.exitCode === 0 ? parseDaily(ran.stdout) : null
    if (found) {
      await update($, daily, () => ({ ...found, fetchedAt: at, error: null, isRunning: false }))
      await $.store.set(DAILY_KEY, { ...found, fetchedAt: at })
    } else {
      const error = ran?.exitCode === 0 ? 'ccusage 的输出看不懂' : dailyError(ran)
      await update($, daily, d => ({ ...(d ?? emptyDaily()), error, isRunning: false }))
    }
  } finally {
    isDailyRunning = false
  }
}

// 启动时先拿上一次存下的画上，再看要不要重新算。热重载时上一个环境里没跑完的 ccusage 已经没人等了，
// 「正在刷新」要清掉，不然一直挂着
const loadDaily = async ($: EngineInterface) => {
  await update($, daily, d => (d?.isRunning ? { ...d, isRunning: false } : d))
  if (!(await read($, daily))) {
    const stored = parseStored(await $.store.get(DAILY_KEY))
    if (stored) {
      await update($, daily, d => d ?? { ...stored, error: null, isRunning: false })
    }
  }
  await refreshDaily($)
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
  // 在 git 仓库里 HUD 上的 +N -M 由快照对比算（工具跑完马上比一次），这里不再加，免得数字先跳一下再落回去
  if ((tool === 'Edit' || tool === 'Write') && (isSnapshotOff || !(await read($, baseTree)))) {
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

// 会话目录，小票里的文件路径写成相对它的；session.start 时记下
let cwdPath = ''
// 记命令连着失败几次时，命令只取这么长做名字
const COMMAND_KEY_MAX = 500

// 每次工具调用：耗时记进统计；子 agent 的调用记到它名下；这一轮还在跑时，命令和改的文件记进小票。
// 主对话这一轮跑完后子 agent 还在后台跑的，不再算进任何一轮的小票。
// 主对话里同一条命令连着失败、同一个文件改了太多次，弹个提示：可能在原地打转（子 agent 的不算，免得刷屏）
const record = async (
  $: EngineInterface,
  e: Record<string, unknown>,
  name: string,
  ms: number,
  done: ToolCallResult | undefined,
) => {
  const tool = String(e.tool)
  const failed = done === undefined || isFailed(done)
  await update($, toolStats, list => withToolTime(list, name, ms, failed))
  const turnIndex = (await read($, activity))?.index ?? null
  await update($, toolCalls, calls =>
    pushCall(calls, { tool: name, ms, failed, label: callLabel(tool, e, cwdPath), turnIndex }),
  )
  const agentId = text(e.agentId)
  if (agentId) {
    await update($, agentLog, log => withAgentTool(log, agentId))
  }
  const isMain = agentId == null
  const result = failed ? null : okResult(done)
  const path = text(e.file_path) ?? text(e.notebook_path)
  const file = path ? relativePath(path, cwdPath) : null
  const command = (text(e.command) ?? '').trim().slice(0, COMMAND_KEY_MAX)
  const isShell = SHELL_TOOLS.has(tool)
  const isEdit = EDIT_TOOLS.has(tool) && result != null && file != null
  // 热重载前记下的这一轮没有 fails / edits
  const after = await update($, activity, a => {
    if (!a?.isRunning) {
      return a
    }
    if (isShell) {
      const fails = a.fails ?? {}

      return {
        ...a,
        receipt: withCommand(a.receipt, command, failed),
        fails: !isMain ? fails : failed ? bump(fails, command) : drop(fails, command),
      }
    }
    if (isEdit && result && file) {
      const edits = a.edits ?? {}

      return {
        ...a,
        receipt: withEdit(a.receipt, file, countPatch(result)),
        edits: isMain ? bump(edits, file) : edits,
      }
    }

    return a
  })
  if (!isMain || !after?.isRunning) {
    return
  }
  const { loopFails, loopEdits } = config
  if (isShell && failed && loopFails > 0 && after.fails[command] === loopFails) {
    const label = clip(command.split('\n')[0] ?? '', 60)
    $.ui.toast(`同一条命令连着失败 ${loopFails} 次了，可能在原地打转：${label}`, { timeoutMs: ALERT_MS })
  }
  if (isEdit && file && loopEdits > 0 && after.edits[file] === loopEdits) {
    $.ui.toast(`这一轮 ${clip(file, 60)} 已经改了 ${loopEdits} 次，可能在原地打转`, { timeoutMs: ALERT_MS })
  }
}

// HUD 第一行前面 ▸ 加一个空格的宽度
const TOGGLE_WIDTH = 2
// 输入框上方的编号按钮之间空两格
const CHOICE_GAP = 2
// HUD 右边几个按钮之间空两格；常用指令窗口不到这么宽就不放，按钮上的字最多这么宽
const RIGHT_GAP = 2
const QUICK_MIN_COLUMNS = 90
const QUICK_LABEL_MAX = 16
// 改动侧边栏收着时，HUD 第一行最右边放个「◂ 改动」，点了拉出来；摆出来以后用侧边栏右上角自带的 × 关。
// 关掉后屏幕右上角没有插件能画的地方，只能放这里
const SHOW_CHANGES = '◂ 改动'

// 展开时 HUD 下方的明细；最多占终端一半高、20 行
const detailsOf = async ($: EngineInterface, columns: number, viewportRows: number) => {
  const [view, log, live, tools, calls, agentsSeen, s, t, at, spend, fb, tz, threshold, inside] = await Promise.all([
    read($, detailsView),
    read($, turnLog),
    read($, activity),
    read($, toolStats),
    read($, toolCalls),
    read($, agentLog),
    read($, stats),
    read($, tokens),
    read($, now),
    read($, daily),
    read($, fable),
    read($, tzOffset),
    read($, compactAt),
    read($, contextParts),
  ])
  const isRunning = live?.isRunning === true
  const offset = offsetOf(tz, at ?? 0)
  const context = s?.contextTokens ?? null
  const data = {
    view,
    turns: log,
    live: isRunning ? live : null,
    tools,
    calls,
    agents: agentsSeen,
    stats: s,
    tokens: t,
    // 这一轮在跑时每秒都有新的耗时，比按分钟走的 now 新
    now: isRunning ? live.startedAt + live.elapsedMs : (at ?? 0),
    daily: spend,
    cwd: cwdPath,
    alerts: limitWindows(s, fb, at ?? 0, forecastShare()).flatMap(w =>
      w.forecast ? [{ text: alertText(w, at ?? 0, offset), isUrgent: w.forecast.isUrgent }] : [],
    ),
    offset,
    context,
    compactAt: threshold,
    compact: compactForecast(log, context, threshold),
    contextParts: inside,
  }

  return { data, size: { columns, rows: Math.max(10, Math.min(20, Math.floor(viewportRows / 2))) } }
}

// 失败的命令放进输入框：输入框是空的就直接放，已经打了字就另起一行接在后面，不动你打的字
const fillPrompt = async ($: EngineInterface, command: string) => {
  const box = await $.prompt.read().catch(() => null)
  const hasDraft = (box?.text.trim() ?? '') !== ''
  const done = await $.prompt
    .fill(hasDraft ? { text: `\n${command}`, mode: 'append' } : { text: command, mode: 'replace' })
    .catch(() => null)
  if (!done?.isFilled) {
    $.ui.toast('输入框现在放不进去（可能开着别的对话框）', { timeoutMs: 3000 })
  }
}

// 展开明细时顺便看看每天花费要不要重新算
const toggleDetails = async ($: EngineInterface) => {
  const open = await update($, isExpanded, v => !v)
  if (open) {
    void refreshDaily($).catch(() => undefined)
    void refreshContext($).catch(() => undefined)
  }
}

// 缓存能存多久：订阅账号（登录 claude.ai）1 小时，API key 和别家的接口 5 分钟。启动时问一次登录方式
let cacheTtlMs = CACHE_TTL_SHORT_MS

const refreshAuth = async ($: EngineInterface) => {
  const auth = await $.session.authorize().catch(() => null)
  cacheTtlMs = auth?.kind === 'bearer' ? CACHE_TTL_LONG_MS : CACHE_TTL_SHORT_MS
}

// 主对话这一轮里的一次请求答完了：缓存没接上又说得出原因就记进小票，再记下这次请求给下一次比。
// 不是这一轮的请求（别的后台请求）不看，免得被当成换了模型
const noteStep = async ($: EngineInterface, turnId: string, sentAt: number, used: TurnUsage | null) => {
  const a = await read($, activity)
  if (!used || !a?.isRunning || a.turnId !== turnId) {
    return
  }
  const miss = cacheMissOf(await read($, lastStep), used, sentAt, cacheTtlMs)
  if (miss) {
    await update($, activity, x =>
      x?.isRunning && x.turnId === turnId ? { ...x, receipt: withCacheMiss(x.receipt, miss) } : x,
    )
  }
  const at = await $.clock.now()
  await update($, lastStep, () => ({ at, prompt: promptOf(used), model: used.model }))
}

// ---------- 离开时续缓存 ----------

// 订阅账号的缓存存 1 小时：主对话最后一次请求后 55 分钟还没动静，就拿当前对话再问一句「只回复 OK」，
// 读一遍缓存让它重新算 1 小时，你回来时不用把整段上下文重新算一遍；最多续几次在 /config 里改。
// 上下文太小的不续（续一次和重新算差不多）；API key 的缓存只存 5 分钟，几分钟就得续一次，不做
const WARM_AFTER_MS = 55 * 60_000
const WARM_MIN_TOKENS = 30_000
// 该续的时间已经过了这么久（热重载、电脑睡着过），缓存多半已经过期，不补了
const WARM_LAPSED_MS = 5 * 60_000
const WARM_PROMPT = '只回复 OK'
let warmTimer: Timer | null = null

const armWarm = ($: EngineInterface, dueAt: number, at: number) => {
  warmTimer?.cancel()
  warmTimer = $.clock.after(Math.max(0, dueAt - at), () => void keepWarm($).catch(() => undefined))
}

// 你回来了（新的一轮）、压缩过、换了会话：不用再续
const stopWarm = async ($: EngineInterface) => {
  warmTimer?.cancel()
  warmTimer = null
  if (await read($, warm)) {
    await update($, warm, () => null)
  }
}

// 这一轮跑完：从主对话最后一次请求算起，55 分钟后续第一次
const planWarm = async ($: EngineInterface) => {
  const step = await read($, lastStep)
  if (cacheTtlMs !== CACHE_TTL_LONG_MS || config.keepWarmTimes === 0 || !step) {
    await stopWarm($)

    return
  }
  const dueAt = step.at + WARM_AFTER_MS
  await update($, warm, () => ({ dueAt, refreshes: 0 }))
  armWarm($, dueAt, await $.clock.now())
}

const keepWarm = async ($: EngineInterface) => {
  warmTimer = null
  const [w, a, s, now] = await Promise.all([read($, warm), read($, activity), read($, stats), $.clock.now()])
  if (!w || w.dueAt == null || a?.isRunning) {
    return
  }
  // 电脑睡着过、计时器晚了太久：缓存已经过期，续也是把整段重新算一遍，不续了
  const isLapsed = now - w.dueAt > WARM_LAPSED_MS
  if (isLapsed || w.refreshes >= config.keepWarmTimes || (s?.contextTokens ?? 0) < WARM_MIN_TOKENS) {
    await update($, warm, x => (x ? { ...x, dueAt: null } : x))

    return
  }
  const r = await $.model.fork({ prompt: WARM_PROMPT }).catch(() => null)
  const at = await $.clock.now()
  // 续这一次用的 token 也算进本会话的
  if (r && 'usage' in r) {
    const used = r.usage
    await update($, tokens, t => addUsage(t, used))
  }
  // 缓存刚续上：下一次真请求从这时算模型闲了多久（请求多大、哪个模型照旧）
  if (r?.isAnswered) {
    await update($, lastStep, p => (p ? { ...p, at } : p))
  }
  const refreshes = w.refreshes + 1
  const dueAt = refreshes < config.keepWarmTimes ? at + WARM_AFTER_MS : null
  await update($, warm, () => ({ dueAt, refreshes }))
  if (dueAt != null) {
    armWarm($, dueAt, at)
  }
}

// 热重载会丢掉计时器：照记下的时间重新排；已经过了太久的不补
const resumeWarm = async ($: EngineInterface) => {
  const [w, at] = await Promise.all([read($, warm), $.clock.now()])
  if (!w || w.dueAt == null || warmTimer) {
    return
  }
  if (w.dueAt - at < -WARM_LAPSED_MS) {
    await update($, warm, x => (x ? { ...x, dueAt: null } : x))

    return
  }
  armWarm($, w.dueAt, at)
}

// ---------- 按钮替你发的话 ----------

// 输入框是空的就直接发出去，算你自己说的；已经打了字就另起一行接在后面，不替你发，免得把没打完的话发出去
const sendOrFill = async ($: EngineInterface, text: string) => {
  const box = await $.prompt.read().catch(() => null)
  if ((box?.text.trim() ?? '') !== '') {
    const done = await $.prompt.fill({ text: `\n${text}`, mode: 'append' }).catch(() => null)
    if (!done?.isFilled) {
      $.ui.toast('输入框现在放不进去（可能开着别的对话框）', { timeoutMs: 3000 })
    }

    return
  }
  await $.prompt.submit({ text, asUser: true })
}

// 回复里的编号按钮：点一下选上，再点取消，按点的先后记
const pickChoice = ($: EngineInterface, n: number) =>
  update($, picked, list => (list.includes(n) ? list.filter(x => x !== n) : [...list, n]))

const sendChoices = async ($: EngineInterface) => {
  const list = await read($, picked)
  if (list.length === 0) {
    return
  }
  await update($, picked, () => [])
  await sendOrFill($, choiceText(list))
}

const tick = async ($: EngineInterface) => {
  const current = await read($, activity)
  if (!current?.isRunning) {
    return
  }
  const at = await $.clock.now()
  await update($, activity, a => (a?.isRunning ? { ...a, elapsedMs: at - a.startedAt } : a))
}

export const register: Register = (on, options) => {
  config = readConfig(options)

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
    $.clock.every(5000, () => void syncChanges($))
    $.clock.every(FABLE_EVERY_MS, () => void refreshFable($))

    const [usage, cwd, configured] = await Promise.all([
      $.session.usage(),
      $.session.cwd(),
      settingsEffort($),
    ])
    cwdPath = cwd
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
    await refreshAuth($)
    await checkLimits($)
    void refreshFable($)
    void resumeWarm($).catch(() => undefined)
    void initBaseline($)
      .then(() => autoOpenChanges($))
      .then(async () => {
        // 热重载前点开的文件重新读一次：旧版本存的改动没记从哪张快照比起
        if ((await read($, changesView)).path) {
          await loadFileDiff($)
        }
      })
      .catch(() => undefined)
    void loadDaily($).catch(() => undefined)
    // 热重载时模型没变也估一次，旧版本没记过自动压缩的点
    void refreshContext($, true).catch(() => undefined)

    return started
  })

  on('turn.start', async ($, e, next) => {
    // 你回话了（点了按钮，或者自己打的）：上一段回复的编号按钮收掉；人回来了，不用再续缓存
    await update($, choices, () => null)
    await update($, picked, () => [])
    await stopWarm($)
    const [startedAt, s] = await Promise.all([$.clock.now(), read($, stats)])
    const cost = s?.costUsd ?? null
    // 上一轮的花费算到这一轮开始为止
    await update($, turnLog, log => withLastCost(log, cost))
    await refreshTurns($)
    const index = await read($, turns)
    // 先给工作区拍一张，这一轮跑完再拍一张，两张一比就是这一轮改的
    const snap = await takeSnapshot($)
    await update($, activity, () => ({
      turnId: e.turnId,
      index,
      startedAt,
      elapsedMs: 0,
      tools: 0,
      activeTool: null,
      isRunning: true,
      costAtStart: cost,
      receipt: emptyReceipt(),
      fails: {},
      edits: {},
      treeAtStart: snap?.tree ?? null,
      // 还没比过，先和开始时一样：按轮看时是空的，不会拿上一轮结束的样子来比
      treeAtEnd: snap?.tree ?? null,
      contextAtStart: s?.contextTokens ?? null,
      isCompacted: false,
    }))
    await refreshModel($)

    return next(e)
  })

  // 每次请求模型时带着实际生效的 effort，/effort 改了这里就跟着变；答完了看缓存接没接上。子 agent 的请求不算
  on('turn.step', async function* ($, e, next) {
    if (e.agentId != null) {
      return yield* next(e)
    }
    await update($, effort, () => (e.effort == null ? null : String(e.effort)))
    const sentAt = await $.clock.now()
    const done = yield* next(e)
    await noteStep($, e.turnId, sentAt, done.usage)

    return done
  })

  on('tool.call', async ($, e, next) => {
    const name = shortTool(e.tool)
    const args = e as unknown as Record<string, unknown>
    const startedAt = await $.clock.now()
    await update($, activity, a => (a?.isRunning ? { ...a, tools: a.tools + 1, activeTool: name } : a))
    if (e.tool === 'Agent') {
      void refreshAgents($)
    }
    let done: ToolCallResult | undefined
    try {
      done = await next(e)
      const result = okResult(done)
      if (result) {
        await track($, e.tool, args, result)
      }

      return done
    } finally {
      await record($, args, name, (await $.clock.now()) - startedAt, done)
      await update($, activity, a => (a?.activeTool === name ? { ...a, activeTool: null } : a))
      if (MUTATING_TOOLS.has(e.tool)) {
        void refreshGit($)
        void refreshChanges($)
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const used = e.usage
    const isMain = e.agentId == null
    if (used) {
      await update($, tokens, t => addUsage(t, used))
      await update($, activity, a => (a?.isRunning ? { ...a, receipt: withTokens(a.receipt, used, isMain) } : a))
    }
    // 子 agent 每跑完一次也算一个 turn.complete，不能把主对话的本轮当成结束了
    if (e.agentId != null) {
      const id = e.agentId
      const ended = await $.clock.now()
      await update($, agentLog, log => withAgentRun(log, id, used, e.reason, ended, e.answer))
      void refreshAgents($)

      return done
    }
    const answer = e.answer.trim()
    if (answer) {
      await update($, { ...answered, id: hashText(answer) }, () => true)
    }
    // 小票里改的文件以 git 前后对比的为准
    await refreshChanges($)
    const [at, s] = await Promise.all([$.clock.now(), read($, stats)])
    const finished = await update($, activity, a =>
      a ? { ...a, isRunning: false, activeTool: null, elapsedMs: at - a.startedAt } : a,
    )
    if (finished) {
      await update($, turnLog, log =>
        pushTurn(log, toTurn(finished, e.durationMs, e.reason, s?.costUsd ?? null, s?.contextTokens ?? null)),
      )
    }
    // 回复里有让你挑的编号，在输入框上方画成按钮；被中断、出错的不算
    const items = e.reason === 'answer' ? parseChoices(e.answer) : []
    await update($, choices, () => (items.length >= 2 ? { turnId: e.turnId, items } : null))
    await update($, picked, () => [])
    await planWarm($)
    await refreshNow($)
    await refreshGit($)
    await refreshAgents($)
    void refreshFable($)
    void refreshDaily($).catch(() => undefined)
    void refreshContext($, true).catch(() => undefined)

    return done
  })

  on('session.measure', async ($, e, next) => {
    await update($, stats, s => toStats(e, s?.startedAt ?? null))
    if (e.changed.includes('rateLimits')) {
      await checkLimits($)
    }
    // 两轮之间才到的上下文读数算到上一轮（只往大了改）
    if (!(await read($, activity))?.isRunning) {
      await update($, turnLog, log => withLastContext(log, e.context.tokens ?? null))
    }
    // 正在跑的这一轮实时算花费；两轮之间才到的花费算到上一轮
    const cost = e.cost?.usd ?? null
    if (cost != null) {
      if ((await read($, activity))?.isRunning) {
        await update($, activity, a =>
          a?.isRunning ? { ...a, receipt: { ...a.receipt, costUsd: costSince(a.costAtStart, cost) } } : a,
        )
      } else {
        await update($, turnLog, log => withLastCost(log, cost))
      }
    }

    return next(e)
  })

  // 主对话这一轮里压缩过，这一轮上下文的涨跌就不算数了（precompute 只是先备好摘要，不算）；
  // 压缩后缓存本来就接不上，下一次请求不拿压缩前的比，免得算成缓存过期
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId == null && e.trigger !== 'precompute' && !('skip' in done && done.skip)) {
      await update($, activity, a => (a?.isRunning ? { ...a, isCompacted: true } : a))
      await update($, lastStep, () => null)
      await stopWarm($)
    }

    return done
  })

  // 起子 agent 时记下它是什么、在第几轮起的
  on('agent.spawn', async ($, e, next) => {
    const done = await next(e)
    if (done.deny === undefined && done.agentId) {
      const id = done.agentId
      const [at, a] = await Promise.all([$.clock.now(), read($, activity)])
      await update($, agentLog, log =>
        withSpawn(
          log,
          {
            id,
            type: e.subagentType,
            description: e.description,
            model: done.model,
            turnIndex: a?.index ?? null,
            startedAt: at,
          },
          e.prompt,
        ),
      )
      await update($, activity, x => (x?.isRunning ? { ...x, receipt: { ...x.receipt, agents: x.receipt.agents + 1 } } : x))
    }

    return done
  })

  // /clear 和 /resume 换到了另一个会话：引擎的花费、上下文、开始时间都换成新会话的
  // （measure 不带开始时间，得重新问），自己累计的 token、改动行数、待办和上一轮也清掉，不然两边对不上；
  // 改动行数从这时重新拍快照来比。不放在 session.start 里清：热重载也会触发 session.start，会把正用着的数清掉
  on('command.run', { command: ['clear', 'resume'] }, async ($, e, next) => {
    const done = await next(e)
    const usage = await $.session.usage()
    await update($, stats, () => toStats(usage, usage.startedAt))
    await update($, tokens, () => null)
    await update($, diff, () => null)
    await update($, todos, () => null)
    await update($, activity, () => null)
    await update($, turnLog, () => [])
    await update($, toolStats, () => [])
    await update($, agentLog, () => [])
    await update($, toolCalls, () => [])
    await update($, detailsView, () => defaultView())
    await update($, baseTree, () => null)
    await update($, sessionFiles, () => [])
    await update($, lastTree, () => null)
    await update($, changesView, () => ({ path: null, page: 0, turn: null }))
    await update($, fileDiff, () => null)
    await update($, lastStep, () => null)
    await update($, choices, () => null)
    await update($, picked, () => [])
    await stopWarm($)
    await refreshTurns($)
    void initBaseline($).catch(() => undefined)

    return done
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

  // 改动侧边栏：会话开始以来改过的文件，● 是这一轮改过的；点一个看它改了什么。也能按轮看，一轮一轮翻
  on('ui.render', { component: 'Pane', requestId: CHANGES_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [base, view, shownDiff, a, log, range] = await Promise.all([
      read($, baseTree),
      read($, changesView),
      read($, fileDiff),
      read($, activity),
      read($, turnLog),
      rangeOf($),
    ])
    const latest = a?.isRunning ? a.receipt : log.at(-1)?.receipt
    // 所有轮次按先后，还在跑的排最后；上一轮、下一轮只在改过文件的里面找
    const order = [
      ...log.map(t => ({ id: t.turnId, hasFiles: t.receipt.files.length > 0 })),
      ...(a?.isRunning ? [{ id: a.turnId, hasFiles: a.receipt.files.length > 0 }] : []),
    ]
    const at = range.turn ? order.findIndex(t => t.id === range.turn?.id) : order.length
    const prev = order.slice(0, Math.max(0, at)).filter(t => t.hasFiles).at(-1)?.id ?? null
    const next = range.turn ? (order.slice(at + 1).find(t => t.hasFiles)?.id ?? null) : null

    return drawChanges(
      { Box, Text, Button },
      {
        isTracked: base != null,
        files: range.files,
        turnFiles: range.turn ? new Set() : new Set((latest?.files ?? []).map(f => f.path)),
        view,
        // 读的是别的范围（刚换了轮）就先不画
        diff: shownDiff && shownDiff.base === range.from ? shownDiff : null,
        turn: range.turn,
        canDiff: range.from != null && range.to != null,
        prev,
        next,
      },
      { columns: e.props.bodyColumns, rows: e.props.scroll.bodyRows },
      {
        pick: path => void pickFile($, path),
        page: page => void update($, changesView, v => ({ ...v, page })),
        scope: turnId => void showScope($, turnId),
      },
    )
  })

  // 侧边栏关了，HUD 右边的开关跟着变；你亲手关掉的还要记下，以后启动不再自己打开（从明细或开关点开会改回来）
  on('ui.close', async ($, e, next) => {
    const done = await next(e)
    if (e.id === CHANGES_PANE) {
      await update($, isChangesUp, () => false)
      if (e.origin?.kind === 'person') {
        await $.store.set(CHANGES_KEY, 'closed')
      }
    }

    return done
  })

  // 每轮结尾那行（✻ … for 1m 14s）下面另起一行写这一轮的小票：花了多少、改了哪些文件、几条命令失败。
  // 那行只带用时，按用时对上是哪一轮；对不上（比如这次启动前的轮次）就原样画。
  // 不接在那行后面：引擎那行占满整行宽，接在后面的字会被挤到最右边折成好几行
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const line = await next(e)
    if (e.surface !== 'terminal') {
      return line
    }
    const turn = matchTurn(await read($, turnLog), e.props.durationMs)
    const pieces = turn ? receiptPieces(turn.receipt) : []
    if (pieces.length === 0) {
      return line
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {line}
        <Box paddingLeft={2}>
          <Text wrap="truncate-end">
            <Text dimColor>{'⎿  '}</Text>
            {pieces.map(p => (
              <Text {...(p.color ? { color: p.color } : {})} {...(p.dim ? { dimColor: true } : {})}>
                {p.text}
              </Text>
            ))}
          </Text>
        </Box>
      </Box>
    )
  })

  // 每轮回复的最后一段下面空一行画个暗色的 copy，点了把这段 markdown 放进剪贴板，和 /copy 走同一条路。
  // 只在全屏终端画：主屏模式收不到点击，画了也按不动；中间的进度说明和折叠的摘要不带
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const message = await next(e)
    const text = e.props.text.trim()
    if (e.surface !== 'terminal' || e.props.isSummary || e.viewport?.isFullscreen === false || !text) {
      return message
    }
    if (!(await read($, { ...answered, id: hashText(text) }))) {
      return message
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const flash = memberOf(copiedAt, e)
    const isCopied = (await read($, flash)) != null
    // 成功了按钮换成一会儿 ✓ copied 再换回来；连点时只有最后一次能换回来
    const copy = async (press: UiPressArgument) => {
      const done = await $.ui.copy({ text, surface: press.surface })
      if (!done.isCopied) {
        $.ui.toast(`复制失败：${done.reason}`, { timeoutMs: 3000 })

        return
      }
      const at = await $.clock.now()
      await update($, flash, () => at)
      await $.clock.sleep(COPIED_MS)
      await update($, flash, v => (v === at ? null : v))
    }

    // 和 PromptHint 一样，包着引擎节点的 Box 不能带 width。
    // copy 前面留两格（正好对齐回复正文），鼠标指到这一小块时格子里冒出 ❯；
    // 格子定宽，箭头出来不挤动 copy，回复其他地方指上去什么都不变
    return (
      <Box flexDirection="column">
        {message}
        <Box marginTop={1}>
          {isCopied ? (
            <Box marginLeft={2}>
              <Text color="success">✓ copied</Text>
            </Box>
          ) : (
            <Box key="copy-area">
              <Box width={2}>
                <Box display="none" hover={{ display: 'flex' }}>
                  <Text>❯</Text>
                </Box>
              </Box>
              <Button key="copy" plain dimColor onPress={copy}>
                copy
              </Button>
            </Box>
          )}
        </Box>
      </Box>
    )
  })

  // 我回复里让你挑的编号，在输入框上方画成按钮：点选（可以多选），再点「发送」，按点的先后发出去（15、1423）。
  // 被问卷占着、回合在跑、HUD 关着时不画；你回了话（新的一轮开始）就收掉，点 × 也收掉
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const [list, sel, hidden] = await Promise.all([read($, choices), read($, picked), read($, isHidden)])
    if (!list || hidden || e.props.hasSurvey || e.props.isWorking) {
      return rest
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const prefix = '点选（可多选）：'
    const send = `发送 ${choiceText(sel)}`
    const cells: { width: number; node: RenderElement }[] = [
      { width: cellWidth(prefix), node: <Text dimColor>{prefix}</Text> },
      ...list.items.map(c => {
        const isOn = sel.includes(c.n)
        const label = `${isOn ? '●' : '○'} ${c.n} ${c.label}`

        return {
          width: cellWidth(label),
          node: (
            <Button key={`choice:${c.n}`} plain {...(isOn ? {} : { dimColor: true })} onPress={() => void pickChoice($, c.n)}>
              {label}
            </Button>
          ),
        }
      }),
      // 「发送」画成 [ 发送 15 ]，比两边宽 4 格
      ...(sel.length
        ? [
            {
              width: cellWidth(send) + 4,
              node: (
                <Button key="choice:send" variant="primary" onPress={() => void sendChoices($).catch(() => undefined)}>
                  {send}
                </Button>
              ),
            },
          ]
        : []),
      {
        width: 1,
        node: (
          <Button key="choice:close" plain dimColor role="dismiss" onPress={() => void update($, choices, () => null)}>
            ×
          </Button>
        ),
      },
    ]
    // 一个接一个排，一行放不下就换行
    const width = Math.max(20, e.props.bodyColumns)
    const rows = cells.reduce<(typeof cells)[]>((done, c) => {
      const row = done.at(-1)
      const used = row ? row.reduce((n, x) => n + x.width + CHOICE_GAP, 0) : 0
      if (row && used + c.width <= width) {
        row.push(c)

        return done
      }

      return [...done, [c]]
    }, [])

    return (
      <Box flexDirection="column">
        {rows.map(r => (
          <Box columnGap={CHOICE_GAP}>{r.map(c => c.node)}</Box>
        ))}
        {rest}
      </Box>
    )
  })

  // 第一行照常是引擎自己的提示（⏵⏵ bypass permissions 等），HUD 另起两行（窄窗口三行）画在它下面。
  // HUD 第一行最前面的 ▸ 点一下在下方展开明细（每轮花费和 token、工具耗时、子 agent），变成 ▾，再点收起
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = await next(e)
    if (await read($, isHidden)) {
      return line
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const [s, id, level, g, d, a, at, t, df, td, n, fb, tn, v, tz, expanded, log, threshold, base, isUp, w] =
      await Promise.all([
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
        read($, isExpanded),
        read($, turnLog),
        read($, compactAt),
        read($, baseTree),
        read($, isChangesUp),
        read($, warm),
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
      compact: compactForecast(log, s?.contextTokens ?? null, threshold),
      warm: w,
    }
    const viewportColumns = e.viewport?.columns ?? 120
    // 每行前面留两格给 ▸
    const columns = Math.max(20, viewportColumns - 4 - TOGGLE_WIDTH)
    // 侧边栏收着、又是 git 仓库（不是仓库的看不了改动）才放「◂ 改动」，在第一行右边；
    // 常用指令在窗口够宽、这一轮没在跑时放，在最后一行右边；只有一行时两样都在这行。各行先给它们留出位置
    const side = base && !isUp ? SHOW_CHANGES : null
    const quick = !a?.isRunning && viewportColumns >= QUICK_MIN_COLUMNS ? config.quickPrompts : []
    const rightWidth = (isFirst: boolean, isLast: boolean) => {
      const widths = [
        ...(isFirst && side ? [cellWidth(side)] : []),
        ...(isLast ? quick.map(q => cellWidth(clip(q, QUICK_LABEL_MAX))) : []),
      ]

      return widths.length ? 1 + widths.reduce((sum, w) => sum + w, 0) + RIGHT_GAP * (widths.length - 1) : 0
    }
    const plan = layout(viewportColumns)
    const rows = plan.reduce<{ groups: Variant[]; isLast: boolean }[]>((drawn, row, i) => {
      const isLast = i === plan.length - 1
      const groups = fit(row.segments(view), row.degrade, columns - rightWidth(drawn.length === 0, isLast))

      return groups.length > 0 || (isLast && quick.length > 0) ? [...drawn, { groups, isLast }] : drawn
    }, [])

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

    const toggle = (
      <Box flexShrink={0} marginRight={1}>
        <Button key="hud:details" plain dimColor onPress={() => void toggleDetails($)}>
          {expanded ? '▾' : '▸'}
        </Button>
      </Box>
    )
    const right = (isFirst: boolean, isLast: boolean) => {
      const buttons = [
        ...(isFirst && side
          ? [
              <Button key="hud:changes" plain dimColor onPress={() => void openChanges($).catch(() => undefined)}>
                {side}
              </Button>,
            ]
          : []),
        ...(isLast
          ? quick.map((q, i) => (
              <Button key={`quick:${i}`} plain dimColor onPress={() => void sendOrFill($, q).catch(() => undefined)}>
                {clip(q, QUICK_LABEL_MAX)}
              </Button>
            ))
          : []),
      ]

      return (
        buttons.length > 0 && (
          <Box flexGrow={1} flexShrink={0} justifyContent="flex-end" marginLeft={1} columnGap={RIGHT_GAP}>
            {buttons}
          </Box>
        )
      )
    }
    const shown = expanded ? await detailsOf($, columns, e.viewport?.rows ?? 40) : null
    const details = shown
      ? drawDetails({ Box, Text, Button }, shown.data, shown.size, {
          setView: change => void update($, detailsView, change),
          refreshDaily: () => void refreshDaily($, true).catch(() => undefined),
          fillPrompt: command => void fillPrompt($, command),
          refreshContext: () => void refreshContext($, true).catch(() => undefined),
          openChanges: turnId => void openChanges($, turnId).catch(() => undefined),
        })
      : null

    // 引擎自己的那行不能放在带 width 的 Box 里，否则整棵树会被拒绝，外层只靠 column 拉伸。
    // 每行从左往右连着画，不往右顶：宽屏上贴右边的内容离左边太远，看着像不属于 HUD。
    // 第一行前面是 ▸，其他行空出同样宽，和第一行对齐；只有「◂ 改动」和常用指令贴最右边
    return (
      <Box flexDirection="column">
        {line}
        {rows.map(({ groups, isLast }, i) => (
          <Box width="100%" {...(i ? { paddingLeft: TOGGLE_WIDTH } : {})}>
            {i === 0 && toggle}
            <Text wrap="truncate-end">{draw(groups)}</Text>
            {right(i === 0, isLast)}
          </Box>
        ))}
        {details && (
          <Box marginTop={1} paddingLeft={TOGGLE_WIDTH}>
            {details}
          </Box>
        )}
      </Box>
    )
  })
}
