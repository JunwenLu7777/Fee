// HUD 和明细面板共用的格式化：数字、时长、按终端格子算的宽度

const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff)

export const cellWidth = (s: string) => {
  let width = 0
  for (const ch of s) {
    width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  }

  return width
}

export const clip = (s: string, max: number) => {
  if (cellWidth(s) <= max) {
    return s
  }
  let out = ''
  for (const ch of s) {
    if (cellWidth(out + ch) > max - 1) {
      break
    }
    out += ch
  }

  return `${out}…`
}

// 路径放不下时留后面：…/hooks/register.tsx，文件名最要紧
export const clipStart = (s: string, max: number) => {
  if (cellWidth(s) <= max) {
    return s
  }
  let out = ''
  for (const ch of [...s].reverse()) {
    if (cellWidth(ch + out) > max - 1) {
      break
    }
    out = ch + out
  }

  return `…${out}`
}

// 按格子补空格到 width，放不下就截断；中文占两格
export const padEnd = (s: string, width: number) => {
  const cut = clip(s, width)

  return cut + ' '.repeat(Math.max(0, width - cellWidth(cut)))
}

export const padStart = (s: string, width: number) => {
  const cut = clip(s, width)

  return ' '.repeat(Math.max(0, width - cellWidth(cut))) + cut
}

// 999_500 起就进到 M，不然会出现 1000k
export const formatTokens = (n: number) => {
  if (n >= 999_500) {
    return `${Math.round(n / 100_000) / 10}M`
  }
  if (n >= 10_000) {
    return `${Math.round(n / 1000)}k`
  }

  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`
}

// 本轮耗时：12s、3m4s、1h2m
export const formatElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) {
    return `${s}s`
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m${s % 60}s`
  }

  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

// 工具耗时常在一秒以内：80ms、1.4s，再长就和本轮耗时一样
export const formatMs = (ms: number) => {
  const n = Math.max(0, Math.round(ms))
  if (n < 1000) {
    return `${n}ms`
  }

  return n < 10_000 ? `${(n / 1000).toFixed(1)}s` : formatElapsed(n)
}

// 会话时长、限额重置倒计时：42m、1h30m、3d4h
export const formatSpan = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`
  }

  return hours % 24 ? `${Math.floor(hours / 24)}d${hours % 24}h` : `${Math.floor(hours / 24)}d`
}

export const formatUsd = (usd: number) => `$${usd.toFixed(2)}`

// ---------- 本地时间：插件环境里的 Date 不一定是本机时区，按启动时问到的偏移（分钟）自己算 ----------

const pad2 = (n: number) => String(n).padStart(2, '0')

const localDate = (at: number, offsetMinutes: number) => new Date(at + offsetMinutes * 60_000)

// 15:40
export const formatClock = (at: number, offsetMinutes: number) => {
  const d = localDate(at, offsetMinutes)

  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

// 2026-10-08，和 ccusage 按天分组用的一样
export const dayKey = (at: number, offsetMinutes: number) => {
  const d = localDate(at, offsetMinutes)

  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

// 2026-10-08 → 周四
export const weekdayOf = (key: string) => `周${WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()] ?? ''}`

// 今天的只写钟点 15:40，别的天带上星期：周五 15:40
export const formatWhen = (at: number, now: number, offsetMinutes: number) => {
  const day = dayKey(at, offsetMinutes)
  const clock = formatClock(at, offsetMinutes)

  return day === dayKey(now, offsetMinutes) ? clock : `${weekdayOf(day)} ${clock}`
}

// 插件环境里的 Date 不一定是本机时区，优先用启动时问到的偏移
export const offsetOf = (tz: number | null, at: number) => tz ?? -new Date(at).getTimezoneOffset()
