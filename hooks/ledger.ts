import type { AgentInfo, TurnUsage } from 'claude-code'

import type {
  HudActivity,
  HudAgent,
  HudCacheMiss,
  HudDetailsView,
  HudDiff,
  HudFileEdit,
  HudReceipt,
  HudStep,
  HudTokens,
  HudToolCall,
  HudToolStat,
  HudTurn,
} from '../types'

import { clip } from './format'

// 每轮小票、工具耗时、子 agent 的记账：只有纯函数，不碰 $

export const TURN_LOG_MAX = 100
export const AGENT_LOG_MAX = 50
export const TOOL_CALLS_MAX = 300
const PROMPT_KEEP = 300
const REPORT_KEEP = 800
const FAILED_KEEP = 5
const COMMAND_LABEL_MAX = 80
// 失败的命令留原文，点了放进输入框；太长的截掉
const FAILED_COMMAND_MAX = 1000
// 估还能撑几轮时，看最近几轮上下文平均涨多少
const GROWTH_SAMPLE = 5
// 每轮结尾那行（✻ … for 3s）只带用时，和 turn.complete 报的可能差一点，差这么多以内都算同一轮
const MATCH_TOLERANCE_MS = 2000

// 同一条命令连着失败几次、同一个文件一轮里改了几次，到这个数就提醒一次「可能在原地打转」；嫌烦就调大
export const LOOP_FAILS = 3
export const LOOP_EDITS = 10

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

export const emptyReceipt = (): HudReceipt => ({
  costUsd: null,
  tokens: null,
  model: null,
  files: [],
  commands: 0,
  failed: 0,
  failedCommands: [],
  agents: 0,
  cacheMiss: null,
})

export const addUsage = (t: HudTokens | null, u: Omit<TurnUsage, 'model'>): HudTokens => ({
  input: (t?.input ?? 0) + u.input_tokens,
  output: (t?.output ?? 0) + u.output_tokens,
  cacheRead: (t?.cacheRead ?? 0) + u.cache_read_input_tokens,
  cacheWrite: (t?.cacheWrite ?? 0) + u.cache_creation_input_tokens,
})

type Hunk = { lines?: unknown }

// Edit / Write 的结果里数 structuredPatch 的 +/- 行；新建文件没有 patch，按内容行数算
export const countPatch = (result: Record<string, unknown>): HudDiff | null => {
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
    const body = result.content.replace(/\n$/, '')
    added = body === '' ? 0 : body.split('\n').length
  }

  return added || removed ? { added, removed } : null
}

// 被拒、报错（命令退出码不是 0 也是报错）都算失败
export const isFailed = (done: unknown) => {
  const r = (done ?? {}) as { deny?: unknown; isError?: unknown }

  return r.deny !== undefined || r.isError === true
}

// 会话目录下的写成相对路径，别处的保留原样
export const relativePath = (path: string, cwd: string) => {
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`

  return cwd && path.startsWith(base) ? path.slice(base.length) : path
}

export const costSince = (start: number | null, now: number | null) =>
  start != null && now != null ? Math.max(0, now - start) : null

// ---------- 一轮的小票 ----------

export const sumLines = (files: readonly HudFileEdit[]): HudDiff => ({
  added: files.reduce((n, f) => n + f.added, 0),
  removed: files.reduce((n, f) => n + f.removed, 0),
})

export const withEdit = (r: HudReceipt, path: string, counted: HudDiff | null): HudReceipt => {
  const added = counted?.added ?? 0
  const removed = counted?.removed ?? 0
  const isKnown = r.files.some(f => f.path === path)

  return {
    ...r,
    files: isKnown
      ? r.files.map(f => (f.path === path ? { ...f, added: f.added + added, removed: f.removed + removed } : f))
      : [...r.files, { path, added, removed }],
  }
}

// 命令只留第一行，太长截断
export const commandLabel = (command: string) => clip(command.trim().split('\n')[0] ?? '', COMMAND_LABEL_MAX)

export const defaultView = (): HudDetailsView => ({
  tab: 'turns',
  turn: null,
  turnSort: 'recent',
  page: 0,
  isTurnFull: false,
  tool: null,
  toolSort: 'total',
  agent: null,
  spendBy: 'day',
})

// 一次调用在明细里怎么称呼：命令看第一行，读写文件看路径
export const callLabel = (tool: string, args: Record<string, unknown>, cwd: string) => {
  if (SHELL_TOOLS.has(tool) && typeof args.command === 'string') {
    return commandLabel(args.command)
  }
  const path = typeof args.file_path === 'string' ? args.file_path : args.notebook_path

  return typeof path === 'string' ? relativePath(path, cwd) : ''
}

export const pushCall = (calls: readonly HudToolCall[], call: HudToolCall): HudToolCall[] =>
  [...calls, call].slice(-TOOL_CALLS_MAX)

export const withCommand = (r: HudReceipt, command: string, failed: boolean): HudReceipt => ({
  ...r,
  commands: r.commands + 1,
  failed: r.failed + (failed ? 1 : 0),
  failedCommands: failed
    ? [...r.failedCommands, command.trim().slice(0, FAILED_COMMAND_MAX)].slice(-FAILED_KEEP)
    : r.failedCommands,
})

// 子 agent 的 token 也算进开它的那一轮；模型按主对话的记
export const withTokens = (r: HudReceipt, u: TurnUsage, isMain: boolean): HudReceipt => ({
  ...r,
  tokens: addUsage(r.tokens, u),
  model: isMain ? u.model : r.model,
})

// ---------- 缓存接没接上 ----------

// 上一次请求至少这么大才看；这次比上次小了三成以上是压缩或清空过，不算；
// 比上次少读了这么多缓存（至少 1 万、上一次的三成）才算没接上
const CACHE_MIN_PROMPT = 20_000
const CACHE_SHRINK = 0.7
const CACHE_LOST_MIN = 10_000
const CACHE_LOST_SHARE = 0.3
// 缓存能存多久：订阅账号（登录 claude.ai）1 小时，API key 5 分钟；模型闲过这么久，缓存多半过期了
export const CACHE_TTL_LONG_MS = 60 * 60_000
export const CACHE_TTL_SHORT_MS = 5 * 60_000

// 一次请求一共多少 token：没缓存的、从缓存读的、写进缓存的
export const promptOf = (u: TurnUsage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

// 主对话这次请求和上一次比，缓存没接上又说得出原因（模型闲得比缓存能存的还久、换了模型）才算；
// 别的原因（比如 Claude Code 自己清掉了旧的工具结果）不算，免得常常报
export const cacheMissOf = (
  prev: HudStep | null,
  u: TurnUsage,
  sentAt: number,
  ttlMs: number,
): HudCacheMiss | null => {
  if (!prev || prev.prompt < CACHE_MIN_PROMPT || promptOf(u) < prev.prompt * CACHE_SHRINK) {
    return null
  }
  const lost = prev.prompt - u.cache_read_input_tokens
  if (lost < Math.max(CACHE_LOST_MIN, prev.prompt * CACHE_LOST_SHARE)) {
    return null
  }
  const idleMs = Math.max(0, sentAt - prev.at)
  const isNewModel = u.model !== prev.model

  return isNewModel || idleMs >= ttlMs ? { tokens: u.cache_creation_input_tokens, idleMs, isNewModel } : null
}

// 一轮里没接上不止一次（比如中间一条命令跑了很久）：重算的加起来，闲得最久的那次
export const withCacheMiss = (r: HudReceipt, miss: HudCacheMiss): HudReceipt => {
  const before = r.cacheMiss

  return {
    ...r,
    cacheMiss: before
      ? {
          tokens: before.tokens + miss.tokens,
          idleMs: Math.max(before.idleMs, miss.idleMs),
          isNewModel: before.isNewModel || miss.isNewModel,
        }
      : miss,
  }
}

// 按名字计数：命令失败一次、文件改一次就加一
export const bump = (counts: Readonly<Record<string, number>>, key: string): Record<string, number> => ({
  ...counts,
  [key]: (counts[key] ?? 0) + 1,
})

// 命令成功了，它连着失败的次数从头数
export const drop = (counts: Readonly<Record<string, number>>, key: string): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).filter(([k]) => k !== key))

// ---------- 跑完的轮次 ----------

// 花费先按现在的算，下一轮开始时再定下来（花费的读数可能比 turn.complete 晚到）；上下文同理。
// 热重载前开始的这一轮没有 contextAtStart / isCompacted
export const toTurn = (
  a: HudActivity,
  durationMs: number,
  reason: string,
  cost: number | null,
  context: number | null,
): HudTurn => ({
  turnId: a.turnId,
  index: a.index,
  startedAt: a.startedAt,
  durationMs,
  tools: a.tools,
  reason,
  costAtStart: a.costAtStart,
  receipt: { ...a.receipt, costUsd: costSince(a.costAtStart, cost) ?? a.receipt.costUsd },
  contextAtStart: a.contextAtStart ?? null,
  contextAtEnd: context,
  isCompacted: a.isCompacted ?? false,
  treeAtStart: a.treeAtStart ?? null,
  treeAtEnd: a.treeAtEnd ?? null,
})

export const pushTurn = (log: readonly HudTurn[], turn: HudTurn): HudTurn[] => [...log, turn].slice(-TURN_LOG_MAX)

// 最后跑完的那一轮，花费算到 cost 为止
export const withLastCost = (log: HudTurn[], cost: number | null): HudTurn[] => {
  const last = log.at(-1)
  const costUsd = last ? costSince(last.costAtStart, cost) : null
  if (!last || costUsd == null || costUsd === last.receipt.costUsd) {
    return log
  }

  return [...log.slice(0, -1), { ...last, receipt: { ...last.receipt, costUsd } }]
}

// 最后跑完的那一轮，上下文晚到的读数只往大了改：两轮之间手动 /compact 变小的不是这一轮的事
export const withLastContext = (log: HudTurn[], context: number | null): HudTurn[] => {
  const last = log.at(-1)
  if (!last || context == null || last.isCompacted || (last.contextAtEnd != null && context <= last.contextAtEnd)) {
    return log
  }

  return [...log.slice(0, -1), { ...last, contextAtEnd: context }]
}

// 这一轮让上下文涨了多少；压缩过、或者不知道的为 null
export const contextGrowth = (t: Pick<HudTurn, 'contextAtStart' | 'contextAtEnd' | 'isCompacted'>) =>
  !t.isCompacted && t.contextAtStart != null && t.contextAtEnd != null ? t.contextAtEnd - t.contextAtStart : null

export type CompactForecast = {
  // 还能完整跑几轮才到自动压缩；0 是下一轮就可能压缩
  turnsLeft: number
  // 最近几轮平均每轮涨多少
  perTurn: number
  // 拿了几轮来算
  sample: number
}

// 照最近几轮上下文平均每轮涨多少，估还能撑几轮到自动压缩；不到两轮、或者上下文没在涨时不估
export const compactForecast = (
  log: readonly HudTurn[],
  current: number | null,
  compactAt: number | null,
): CompactForecast | null => {
  if (current == null || compactAt == null) {
    return null
  }
  const growths = log.flatMap(t => {
    const g = contextGrowth(t)

    return g != null && g > 0 ? [g] : []
  })
  const recent = growths.slice(-GROWTH_SAMPLE)
  if (recent.length < 2) {
    return null
  }
  const perTurn = recent.reduce((n, g) => n + g, 0) / recent.length

  return { turnsLeft: Math.max(0, Math.floor((compactAt - current) / perTurn)), perTurn, sample: recent.length }
}

// 先找用时一样的，再找差得最少的；一样近取后跑的那轮
export const matchTurn = (log: readonly HudTurn[], durationMs: number): HudTurn | null => {
  let best: HudTurn | null = null
  let gap = MATCH_TOLERANCE_MS
  for (const turn of log) {
    const d = Math.abs(turn.durationMs - durationMs)
    if (d <= gap) {
      best = turn
      gap = d
    }
  }

  return best
}

// ---------- 工具耗时 ----------

export const withToolTime = (stats: readonly HudToolStat[], name: string, ms: number, failed: boolean): HudToolStat[] => {
  const one = stats.find(s => s.name === name)

  return [
    ...stats.filter(s => s.name !== name),
    {
      name,
      count: (one?.count ?? 0) + 1,
      totalMs: (one?.totalMs ?? 0) + ms,
      maxMs: Math.max(one?.maxMs ?? 0, ms),
      failed: (one?.failed ?? 0) + (failed ? 1 : 0),
    },
  ]
}

// ---------- 子 agent ----------

type Spawned = Pick<HudAgent, 'id' | 'type' | 'description' | 'model' | 'turnIndex' | 'startedAt'>

export const withSpawn = (log: readonly HudAgent[], agent: Spawned, prompt: string): HudAgent[] =>
  [
    ...log.filter(a => a.id !== agent.id),
    {
      ...agent,
      prompt: clip(prompt.trim(), PROMPT_KEEP) || null,
      report: null,
      endedAt: null,
      status: 'running',
      tools: 0,
      tokens: null,
    },
  ].slice(-AGENT_LOG_MAX)

export const withAgentTool = (log: readonly HudAgent[], id: string): HudAgent[] =>
  log.map(a => (a.id === id ? { ...a, tools: a.tools + 1 } : a))

const ENDED_BY: Record<string, string> = { answer: 'completed', aborted: 'killed', refusal: 'failed', error: 'failed' }

// 子 agent 跑完一次：加上 token，记下结束时间和它交回来的报告
export const withAgentRun = (
  log: readonly HudAgent[],
  id: string,
  usage: TurnUsage | undefined,
  reason: string,
  at: number,
  answer: string,
): HudAgent[] =>
  log.map(a =>
    a.id === id
      ? {
          ...a,
          tokens: usage ? addUsage(a.tokens, usage) : a.tokens,
          endedAt: at,
          status: ENDED_BY[reason] ?? a.status,
          report: clip(answer.trim(), REPORT_KEEP) || a.report,
        }
      : a,
  )

const LIVE_STATUSES = new Set(['pending', 'running', 'waiting'])

// 把 $.agent.list() 的状态同步进来；没变就原样返回，免得每次轮询都重画
export const withStatuses = (log: HudAgent[], list: readonly AgentInfo[], at: number): HudAgent[] => {
  let isChanged = false
  const next = log.map(a => {
    const found = list.find(l => l.id === a.id)
    if (!found || found.status === a.status) {
      return a
    }
    isChanged = true

    return { ...a, status: found.status, endedAt: LIVE_STATUSES.has(found.status) ? null : (a.endedAt ?? at) }
  })

  return isChanged ? next : log
}

export const isLive = (a: HudAgent) => LIVE_STATUSES.has(a.status)
