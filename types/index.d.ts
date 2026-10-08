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
  startedAt: number
  elapsedMs: number
  tools: number
  activeTool: string | null
  isRunning: boolean
  costAtStart: number | null
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
    }
  }
}
