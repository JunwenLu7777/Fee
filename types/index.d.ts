export type HudLimit = {
  percent: number
  resetsAt: number | null
}

export type HudStats = {
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  costUsd: number | null
  startedAt: number | null
  fiveHour: HudLimit | null
  sevenDay: HudLimit | null
}

export type HudGit = {
  branch: string
  changes: number
  untracked: number
  ahead: number
  behind: number
}

export type HudActivity = {
  turnId: string
  // 本会话第几轮，和 HUD 上的 #n 一样
  index: number | null
  startedAt: number
  elapsedMs: number
  tools: number
  activeTool: string | null
  isRunning: boolean
  costAtStart: number | null
  // 这一轮正在记的小票，跑完时存进 turnLog
  receipt: HudReceipt
}

// 整个会话（含子 agent）累计的 token
export type HudTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// 本会话 Edit / Write 累计增删的行数
export type HudDiff = {
  added: number
  removed: number
}

export type HudTodo = {
  id: string
  status: 'pending' | 'in_progress' | 'completed'
  label: string
}

// 一轮里改过的一个文件，路径相对会话目录
export type HudFileEdit = {
  path: string
  added: number
  removed: number
}

// 一轮的小票：花了多少、用了多少 token、改了哪些文件、跑了几条命令；子 agent 做的也算进来
export type HudReceipt = {
  // 这一轮花的：从这一轮开始到下一轮开始之间的花费
  costUsd: number | null
  tokens: HudTokens | null
  model: string | null
  files: HudFileEdit[]
  commands: number
  failed: number
  // 失败的命令，只留最后几条
  failedCommands: string[]
  agents: number
}

// 跑完的一轮
export type HudTurn = {
  turnId: string
  index: number | null
  startedAt: number
  durationMs: number
  tools: number
  // 怎么结束的：answer / aborted / refusal / error
  reason: string
  costAtStart: number | null
  receipt: HudReceipt
}

// 一种工具在本会话里的调用次数和耗时
export type HudToolStat = {
  name: string
  count: number
  totalMs: number
  maxMs: number
  failed: number
}

// 一次工具调用：明细里点工具名时列出它最慢的几次
export type HudToolCall = {
  tool: string
  ms: number
  failed: boolean
  // 命令的第一行，或者读写的文件；别的工具为空
  label: string
  turnIndex: number | null
}

// 本会话起过的一个子 agent
export type HudAgent = {
  id: string
  type: string
  description: string
  // 交给它的任务原文，截短
  prompt: string | null
  // 它最后交回来的报告，截短
  report: string | null
  model: string | null
  // 在主对话第几轮起的
  turnIndex: number | null
  startedAt: number
  endedAt: number | null
  // running / completed / failed / killed …，和 $.agent.list() 的 status 一样
  status: string
  tools: number
  tokens: HudTokens | null
}

export type HudDetailsTab = 'turns' | 'tools' | 'agents'

// 轮次按什么排：recent 最近的在前，其余按那一列从大到小
export type HudTurnSort = 'recent' | 'duration' | 'cost' | 'input' | 'output'
export type HudToolSort = 'total' | 'count' | 'avg' | 'max' | 'failed'

// 明细里点出来的状态：看哪一页、按什么排、选中了谁、展开了谁
export type HudDetailsView = {
  // 窄窗口时看哪一张卡片
  tab: HudDetailsTab
  // 选中的轮次，下面显示它的明细
  turn: string | null
  turnSort: HudTurnSort
  // 轮次翻到第几页，0 是第一页
  page: number
  // 选中那一轮改的文件、失败的命令全部列出来
  isTurnFull: boolean
  // 选中的工具，下面列出它最慢的几次
  tool: string | null
  toolSort: HudToolSort
  // 展开的子 agent
  agent: string | null
}

declare module 'claude-code' {
  interface PluginState {
    hud: {
      stats: HudStats | null
      modelId: string | null
      effort: string | null
      git: HudGit | null
      dir: string | null
      activity: HudActivity | null
      now: number | null
      isHidden: boolean
      tokens: HudTokens | null
      diff: HudDiff | null
      todos: HudTodo[] | null
      agents: number
      fable: HudLimit | null
      turns: number | null
      version: string | null
      tzOffset: number | null
      // 主对话每轮最后那段回复，按内容的哈希记；画回复时对得上的那段带复制按钮
      answered: StateFamily<boolean>
      // 每段回复上次点 copy 的时间，按画出来的那段回复记；刚点过的显示 ✓ copied
      copiedAt: StateFamily<number | null>
      // 跑完的轮次，最近的在最后
      turnLog: HudTurn[]
      toolStats: HudToolStat[]
      // 最近的工具调用，留最后几百次
      toolCalls: HudToolCall[]
      agentLog: HudAgent[]
      // HUD 下方的明细展没展开，和展开后点出来的状态
      isExpanded: boolean
      detailsView: HudDetailsView
    }
  }
}
