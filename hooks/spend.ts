import type { HudDay } from '../types'

// 每天花了多少：ccusage 读本机所有会话的记录算的，这里只管读它的输出、按天加

const DAY_MS = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

const toDay = (item: unknown): HudDay[] => {
  const d = (item ?? {}) as { date?: unknown; totalCost?: unknown; totalTokens?: unknown }

  return typeof d.date === 'string' && DATE.test(d.date) && typeof d.totalCost === 'number'
    ? [{ date: d.date, costUsd: d.totalCost, tokens: typeof d.totalTokens === 'number' ? d.totalTokens : 0 }]
    : []
}

// ccusage daily --json 的输出：{ daily: [{ date: '2026-10-08', totalCost, totalTokens, … }] }；读不懂为 null
export const parseDaily = (out: string): HudDay[] | null => {
  let data: unknown
  try {
    data = JSON.parse(out)
  } catch {
    return null
  }
  const list = (data as { daily?: unknown } | null)?.daily

  return Array.isArray(list) ? list.flatMap(toDay) : null
}

// 存在 $.store 里的上一次结果，下次启动先拿它画
export type StoredDaily = { days: HudDay[]; fetchedAt: number }

export const parseStored = (value: unknown): StoredDaily | null => {
  const v = (value ?? {}) as { days?: unknown; fetchedAt?: unknown }

  return Array.isArray(v.days) && typeof v.fetchedAt === 'number'
    ? { days: v.days.flatMap(d => toDay({ date: d?.date, totalCost: d?.costUsd, totalTokens: d?.tokens })), fetchedAt: v.fetchedAt }
    : null
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
