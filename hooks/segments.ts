// HUD 每一段写什么、放不下时一级一级怎么精简、宽窗口两行窄窗口三行：纯函数，不碰 $

import type { HudActivity, HudWarm, HudDiff, HudGit, HudLimit, HudStats, HudTodo, HudTokens } from '../types'

import { cellWidth, clip, formatClock, formatElapsed, formatSpan, formatTokens, formatWhen, offsetOf } from './format'
import { limitWindows } from './forecast'
import type { LimitWindow } from './forecast'
import type { CompactForecast } from './ledger'
import { config, forecastShare } from './config'
import { prettyModel } from './parse'

const SPINNER = ['◐', '◓', '◑', '◒']
export const SEP = ' │ '

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

type Piece = { text: string; color?: string; dim?: boolean; bold?: boolean }
export type Variant = Piece[]
type Segment = { id: string; variants: Variant[] }

const groupWidth = (variants: Variant[]) =>
  variants.reduce(
    (width, v, i) => width + (i ? SEP.length : 0) + v.reduce((w, p) => w + cellWidth(p.text), 0),
    0,
  )

// degrade 是放不下时一级一级精简的顺序，靠前的先让步
export const fit = (segments: Segment[], degrade: readonly string[], columns: number) => {
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

export type View = {
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

export const layout = (columns: number): Row[] =>
  columns >= TWO_ROWS_MIN_COLUMNS ? [RESOURCES_AND_SPEND, WORKSPACE] : [RESOURCES, SPEND, WORKSPACE]
