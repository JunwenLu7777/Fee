import type { AgentInfo, TurnUsage } from 'claude-code'

import type { HudActivity, HudAgent, HudDetailsView, HudDiff, HudReceipt, HudTokens, HudToolCall, HudToolStat, HudTurn } from '../types'

import { clip } from './format'

// 每轮小票、工具耗时、子 agent 的记账：只有纯函数，不碰 $

export const TURN_LOG_MAX = 100
export const AGENT_LOG_MAX = 50
export const TOOL_CALLS_MAX = 300
const PROMPT_KEEP = 300
const REPORT_KEEP = 800
const FAILED_KEEP = 5
const COMMAND_LABEL_MAX = 80
// 每轮结尾那行（✻ … for 3s）只带用时，和 turn.complete 报的可能差一点，差这么多以内都算同一轮
const MATCH_TOLERANCE_MS = 2000

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
})

export const addUsage = (t: HudTokens | null, u: TurnUsage): HudTokens => ({
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
const commandLabel = (command: string) => clip(command.trim().split('\n')[0] ?? '', COMMAND_LABEL_MAX)

export const defaultView = (): HudDetailsView => ({
  tab: 'turns',
  turn: null,
  turnSort: 'recent',
  page: 0,
  isTurnFull: false,
  tool: null,
  toolSort: 'total',
  agent: null,
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
  failedCommands: failed ? [...r.failedCommands, commandLabel(command)].slice(-FAILED_KEEP) : r.failedCommands,
})

// 子 agent 的 token 也算进开它的那一轮；模型按主对话的记
export const withTokens = (r: HudReceipt, u: TurnUsage, isMain: boolean): HudReceipt => ({
  ...r,
  tokens: addUsage(r.tokens, u),
  model: isMain ? u.model : r.model,
})

// ---------- 跑完的轮次 ----------

// 花费先按现在的算，下一轮开始时再定下来（花费的读数可能比 turn.complete 晚到）
export const toTurn = (a: HudActivity, durationMs: number, reason: string, cost: number | null): HudTurn => ({
  turnId: a.turnId,
  index: a.index,
  startedAt: a.startedAt,
  durationMs,
  tools: a.tools,
  reason,
  costAtStart: a.costAtStart,
  receipt: { ...a.receipt, costUsd: costSince(a.costAtStart, cost) ?? a.receipt.costUsd },
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
