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
  // 主对话这一轮里每条命令连着失败了几次（成功一次就清掉）、每个文件改了几次，用来提醒原地打转
  fails: Record<string, number>
  edits: Record<string, number>
  // 这一轮开始时工作区的 git 快照（树的 id）；不是 git 仓库时为 null，小票退回按 Edit / Write 算
  treeAtStart: string | null
  // 这一轮开始时上下文有多少 token；这一轮里有没有自动压缩过
  contextAtStart: number | null
  isCompacted: boolean
}

// 整个会话（含子 agent）累计的 token
export type HudTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// 本会话开始以来工作区净改的行数（git 快照对比）；不是 git 仓库时按 Edit / Write 累计
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
  // 失败的命令原文（截到一千字），只留最后几条；明细里点一条放进输入框
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
  // 这一轮开始、结束时上下文有多少 token，差就是这一轮让上下文涨了多少；压缩过的不算涨
  contextAtStart: number | null
  contextAtEnd: number | null
  isCompacted: boolean
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

// ccusage 算的某一天：本机所有会话一共花了多少
export type HudDay = {
  // 本地日期，2026-10-08
  date: string
  costUsd: number
  tokens: number
}

// ccusage 算的某个项目某一天花了多少；项目是 ~/.claude/projects 下的文件夹名（会话目录把 / 换成 -）
export type HudProjectDay = {
  project: string
  date: string
  costUsd: number
}

// 每天花费：ccusage 读本机所有会话的记录算的，最近 30 天
export type HudDaily = {
  days: HudDay[]
  // 按项目分的；旧版本存下的没有
  projects: HudProjectDay[]
  // 上次算好的时间；还没算好过为 null
  fetchedAt: number | null
  // 上次没算成的原因；missing 是没装 ccusage
  error: string | null
  isRunning: boolean
}

// 上下文里的一块：系统提示、工具说明、对话……，或者一个 MCP 服务器、一个记忆文件
export type HudContextPart = {
  name: string
  tokens: number
}

// 上下文里装了什么：Claude Code 照 /context 的算法在本地估的，不发请求；每轮跑完估一次
export type HudContextParts = {
  // 什么时候估的
  at: number
  // 占着窗口的几块，从大到小
  parts: HudContextPart[]
  // 按服务器加起来的 MCP 工具说明，只算已经放进窗口的
  mcp: HudContextPart[]
  // 记忆文件（CLAUDE.md 之类）
  memory: HudContextPart[]
  // 按需才加载、不占窗口的工具说明一共多少
  deferred: number
}

// 改动侧边栏里点出来的状态：看哪个文件、它的改动翻到第几页
export type HudChangesView = {
  path: string | null
  page: number
}

// 侧边栏里点开的那个文件改了什么：会话开始到最近一张快照的 git diff，只留前几百行
export type HudFileDiff = {
  path: string
  // 比的是哪张快照，工作区又变了就重新读
  tree: string
  lines: string[]
  isCut: boolean
}

export type HudDetailsTab = 'turns' | 'tools' | 'context' | 'agents' | 'spend'

// 轮次按什么排：recent 最近的在前，其余按那一列从大到小
export type HudTurnSort = 'recent' | 'duration' | 'cost' | 'input' | 'output' | 'context'
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
  // 每天花费按天看还是按项目看
  spendBy: 'day' | 'project'
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
      // 已经提醒过「照现在的速度会提前用完」的额度窗口：标签（5h / 7d / fable）→ 那个窗口的重置时间
      warnedLimits: Record<string, number>
      // 会话开始时工作区的 git 快照（树的 id），HUD 上的 +N -M 和它比
      baseTree: string | null
      daily: HudDaily | null
      // 上下文到多少 token 时自动压缩；自动压缩关了或者还不知道为 null
      compactAt: number | null
      contextParts: HudContextParts | null
      // 会话开始以来改过的文件（git 快照对比），按路径排；最近一张快照；侧边栏里点开的文件和它的改动
      sessionFiles: HudFileEdit[]
      lastTree: string | null
      changesView: HudChangesView
      fileDiff: HudFileDiff | null
      // 改动侧边栏开着、而且摆出来了；没摆出来时 HUD 右边才放「◂ 改动」
      isChangesUp: boolean
    }
  }
}
