// 把引擎、git、接口给的数据整理成 HUD 要的样子：纯函数，不碰 $

import type { SessionRateLimit, SessionUsage } from 'claude-code'

import type { HudGit, HudLimit, HudStats, HudTodo } from '../types'

const toLimit = (limits: readonly SessionRateLimit[], kind: string): HudLimit | null => {
  const found = limits.find(r => r.kind === kind)
  if (!found) {
    return null
  }
  const resetsAt = found.resetsAt ? Date.parse(found.resetsAt) : NaN

  return { percent: found.percentUsed, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
}

export const toStats = (
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
export const parseFable = (body: string): HudLimit | null => {
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
export const parseOffset = (out: string): number | null => {
  const m = out.trim().match(/^([+-])(\d{2})(\d{2})$/)

  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null
}

export const parseGit = (out: string): HudGit | null => {
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
export const okResult = (done: unknown): Record<string, unknown> | null => {
  const r = done as { deny?: unknown; isError?: unknown; result?: unknown }
  if (r.deny !== undefined || r.isError === true) {
    return null
  }

  return r.result && typeof r.result === 'object' ? (r.result as Record<string, unknown>) : null
}

const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const

export const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)

export const todoStatus = (v: unknown): HudTodo['status'] | null => TODO_STATUSES.find(s => s === v) ?? null

export const toTodos = (raw: unknown): HudTodo[] =>
  (Array.isArray(raw) ? raw : []).flatMap((item: unknown, i) => {
    const t = (item ?? {}) as Record<string, unknown>
    const status = todoStatus(t.status)

    return status ? [{ id: String(i), status, label: text(t.activeForm) ?? text(t.content) ?? '' }] : []
  })

// FNV-1a 加上长度，只用来认出同一段回复
export const hashText = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }

  return `${s.length}:${(h >>> 0).toString(36)}`
}

export const shortDir = (cwd: string) => {
  if (/^\/(Users|home)\/[^/]+\/?$/.test(cwd)) {
    return '~'
  }

  return cwd.split('/').filter(Boolean).pop() ?? '/'
}

export const shortTool = (tool: string) => {
  const name = tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool

  return name.length > 16 ? `${name.slice(0, 15)}…` : name
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// claude-opus-5-5 → Opus 5.5，claude-haiku-4-5-20251001 → Haiku 4.5，带 [1m] 或窗口 ≥1M 的加上 1M
export const prettyModel = (id: string, window: number | null) => {
  const isLong = /\[1m\]/i.test(id) || (window ?? 0) >= 1_000_000
  const base = id.replace(/\[1m\]/i, '')
  const m = base.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/)
  const family = m?.[1] ? capitalize(m[1]) : null
  const version = m?.[2] ? `${m[2]}${m[3] ? `.${m[3]}` : ''}` : ''
  const name = family ? `${family} ${version}` : base.replace(/^claude-/, '')

  return { full: isLong ? `${name} 1M` : name, short: family ?? name }
}
