import type { HudLimit, HudStats } from '../types'

import { formatSpan, formatWhen } from './format'

// 额度预测：照这个窗口开始到现在的平均速度，重置之前会不会用完、大概几点用完

const HOUR_MS = 3_600_000
const WEEK_MS = 7 * 24 * HOUR_MS
// 窗口刚开始时数据少，速度不准：默认过了窗口的十分之一才预测（5 小时的是 30 分钟）
export const MIN_ELAPSED_SHARE = 0.1
// 用得太少也不预测
const MIN_PERCENT = 5
// 离用完不到窗口的十分之一就标红（5 小时的是 30 分钟）
const URGENT_SHARE = 0.1

export type Forecast = { runOutAt: number; isUrgent: boolean }

// 重置之前就会用完才返回；还没把握（刚开始、用得太少、已经用完、没有重置时间）返回 null。
// minElapsedShare 是窗口过了多少（比例）才开始预测，/config 里能改
export const forecastOf = (
  limit: HudLimit | null,
  windowMs: number,
  now: number,
  minElapsedShare = MIN_ELAPSED_SHARE,
): Forecast | null => {
  if (!limit || limit.resetsAt == null || limit.percent < MIN_PERCENT || limit.percent >= 100) {
    return null
  }
  const start = limit.resetsAt - windowMs
  const elapsed = now - start
  if (elapsed < windowMs * minElapsedShare || now >= limit.resetsAt) {
    return null
  }
  // 这个窗口到现在平均每毫秒用掉 percent / elapsed，用到 100% 的时刻
  const runOutAt = start + (elapsed * 100) / limit.percent
  if (runOutAt >= limit.resetsAt) {
    return null
  }

  return { runOutAt, isUrgent: runOutAt - now < windowMs * URGENT_SHARE }
}

export type LimitWindow = {
  // HUD 上的标签：5h / 7d / fable
  label: string
  // 提示里怎么叫它
  name: string
  limit: HudLimit
  forecast: Forecast | null
}

// 过了重置时间还没有新读数时，旧的百分比已经不作数了（比如歇了一阵回来），按 0% 算
export const live = (limit: HudLimit | null | undefined, at: number): HudLimit | null => {
  if (!limit) {
    return null
  }

  return limit.resetsAt != null && at > 0 && limit.resetsAt <= at ? { percent: 0, resetsAt: null } : limit
}

// 5 小时、7 天和 Fable 周额度，各自带上预测
export const limitWindows = (
  stats: HudStats | null,
  fable: HudLimit | null,
  now: number,
  minElapsedShare = MIN_ELAPSED_SHARE,
): LimitWindow[] =>
  [
    { label: '5h', name: '5 小时额度', limit: live(stats?.fiveHour, now), windowMs: 5 * HOUR_MS },
    { label: '7d', name: '7 天额度', limit: live(stats?.sevenDay, now), windowMs: WEEK_MS },
    { label: 'fable', name: 'Fable 周额度', limit: live(fable, now), windowMs: WEEK_MS },
  ].flatMap(w =>
    w.limit ? [{ ...w, limit: w.limit, forecast: forecastOf(w.limit, w.windowMs, now, minElapsedShare) }] : [],
  )

// 照现在的速度，5 小时额度约 15:40 用完（1h20m 后），16:45 才重置
export const alertText = (w: LimitWindow, now: number, offsetMinutes: number) => {
  const { forecast, limit } = w
  if (!forecast) {
    return ''
  }
  const reset = limit.resetsAt != null ? `，${formatWhen(limit.resetsAt, now, offsetMinutes)} 才重置` : ''

  return `照现在的速度，${w.name}约 ${formatWhen(forecast.runOutAt, now, offsetMinutes)} 用完（${formatSpan(forecast.runOutAt - now)}后）${reset}`
}
