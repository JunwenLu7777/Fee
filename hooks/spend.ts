import type { HudDay, HudProjectDay } from '../types'

// 每天花了多少：ccusage 读本机所有会话的记录算的，这里只管读它的输出、按天加

const DAY_MS = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

const toDay = (item: unknown): HudDay[] => {
  const d = (item ?? {}) as { date?: unknown; totalCost?: unknown; totalTokens?: unknown }

  return typeof d.date === 'string' && DATE.test(d.date) && typeof d.totalCost === 'number'
    ? [{ date: d.date, costUsd: d.totalCost, tokens: typeof d.totalTokens === 'number' ? d.totalTokens : 0 }]
    : []
}

export type DailyData = { days: HudDay[]; projects: HudProjectDay[] }

// 按项目的几张表加成每天一共多少
const sumDays = (rows: readonly (HudDay & { project?: string })[]): HudDay[] => {
  const byDate = new Map<string, HudDay>()
  for (const r of rows) {
    const day = byDate.get(r.date)
    byDate.set(r.date, {
      date: r.date,
      costUsd: (day?.costUsd ?? 0) + r.costUsd,
      tokens: (day?.tokens ?? 0) + r.tokens,
    })
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

// ccusage daily --json --instances 的输出：{ projects: { 项目: [{ date, totalCost, totalTokens, … }] } }；
// 没带 --instances（或者旧版本）是 { daily: [...] }，那就没有按项目的。读不懂为 null
export const parseDaily = (out: string): DailyData | null => {
  let data: unknown
  try {
    data = JSON.parse(out)
  } catch {
    return null
  }
  const { projects, daily } = (data ?? {}) as { projects?: unknown; daily?: unknown }
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    const rows = Object.entries(projects).flatMap(([project, list]) =>
      (Array.isArray(list) ? list.flatMap(toDay) : []).map(d => ({ ...d, project })),
    )

    return { days: sumDays(rows), projects: rows.map(r => ({ project: r.project, date: r.date, costUsd: r.costUsd })) }
  }

  return Array.isArray(daily) ? { days: daily.flatMap(toDay), projects: [] } : null
}

// 存在 $.store 里的上一次结果，下次启动先拿它画；旧版本存的没有按项目的
export type StoredDaily = DailyData & { fetchedAt: number }

const toProjectDay = (item: unknown): HudProjectDay[] => {
  const p = (item ?? {}) as Partial<HudProjectDay>

  return typeof p.project === 'string' && typeof p.date === 'string' && typeof p.costUsd === 'number'
    ? [{ project: p.project, date: p.date, costUsd: p.costUsd }]
    : []
}

export const parseStored = (value: unknown): StoredDaily | null => {
  const v = (value ?? {}) as { days?: unknown; projects?: unknown; fetchedAt?: unknown }

  return Array.isArray(v.days) && typeof v.fetchedAt === 'number'
    ? {
        days: v.days.flatMap(d => toDay({ date: d?.date, totalCost: d?.costUsd, totalTokens: d?.tokens })),
        projects: Array.isArray(v.projects) ? v.projects.flatMap(toProjectDay) : [],
        fetchedAt: v.fetchedAt,
      }
    : null
}

// 项目文件夹名是会话目录把 / 和 . 换成 - 得来的：/Users/me/code/Fee → -Users-me-code-Fee
const encode = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')

const NAME_MAX = 24

// 太长的留后面一截，项目名一般在最后
const tail = (name: string) => (name.length > NAME_MAX ? `…${name.slice(-(NAME_MAX - 1))}` : name)

// 项目怎么称呼：当前项目写文件夹名；和当前项目同一个上级目录、或者在家目录下的，去掉前面那段；都不是的留后面一截
export const projectName = (key: string, cwd: string): { name: string; isCurrent: boolean } => {
  if (cwd && key === encode(cwd)) {
    return { name: cwd.split('/').filter(Boolean).pop() ?? key, isCurrent: true }
  }
  const parent = cwd.split('/').slice(0, -1).join('/')
  const home = cwd.match(/^\/(Users|home)\/[^/]+/)?.[0]
  // 在家目录直接开的会话
  if (home && key === encode(home)) {
    return { name: '~', isCurrent: false }
  }
  for (const base of [parent, home]) {
    const prefix = base ? `${encode(base)}-` : ''
    if (prefix && key.startsWith(prefix) && key.length > prefix.length) {
      return { name: tail(key.slice(prefix.length)), isCurrent: false }
    }
  }

  return { name: tail(key), isCurrent: false }
}

// 最近几天每个项目一共花了多少，从多到少
export const spentByProject = (projects: readonly HudProjectDay[], dates: readonly string[]) => {
  const byProject = new Map<string, number>()
  for (const p of projects) {
    if (dates.includes(p.date)) {
      byProject.set(p.project, (byProject.get(p.project) ?? 0) + p.costUsd)
    }
  }

  return [...byProject].map(([project, costUsd]) => ({ project, costUsd })).sort((a, b) => b.costUsd - a.costUsd)
}

// 从 today 往前 n 天（含今天）的日期，今天在最前
export const lastDays = (today: string, n: number): string[] => {
  const t = Date.parse(`${today}T00:00:00Z`)

  return Array.from({ length: n }, (_, i) => new Date(t - i * DAY_MS).toISOString().slice(0, 10))
}

export const spentOn = (days: readonly HudDay[], dates: readonly string[]) =>
  days.filter(d => dates.includes(d.date)).reduce((n, d) => n + d.costUsd, 0)

// 有 token 却算出 $0：ccusage 不认识这个模型的价格（版本旧，或者离线）
export const isUnpriced = (days: readonly HudDay[]) => days.some(d => d.tokens > 0 && d.costUsd === 0)
