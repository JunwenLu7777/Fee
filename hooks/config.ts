// /config 里能改的几个门槛（plugin.json 的 userConfig），没设就用默认值

import type { PluginOptions } from 'claude-code'

import { MIN_ELAPSED_SHARE } from './forecast'
import { LOOP_EDITS, LOOP_FAILS } from './ledger'

type Config = {
  // 同一条命令连着失败几次、同一个文件一轮里改几次提醒原地打转；0 不提醒
  loopFails: number
  loopEdits: number
  // 额度照现在的速度会提前用完时弹不弹提示（HUD 上照样写）
  limitAlert: boolean
  // 额度窗口过了百分之几才开始预测
  forecastAfter: number
  // 还能撑几轮以内才在 HUD 上写「约 N 轮后压缩」；0 不写
  compactTurns: number
  // HUD 最后一行右边的常用指令，点一下就发出去
  quickPrompts: string[]
  // 离开时最多续几次缓存（订阅账号每次续 1 小时）；0 不续
  keepWarmTimes: number
}

const DEFAULT_CONFIG: Config = {
  loopFails: LOOP_FAILS,
  loopEdits: LOOP_EDITS,
  limitAlert: true,
  forecastAfter: MIN_ELAPSED_SHARE * 100,
  compactTurns: 10,
  quickPrompts: ['提交+push', '接下来做什么'],
  keepWarmTimes: 3,
}

// register 时照 /config 的设置填上
export const config: Config = { ...DEFAULT_CONFIG }
const QUICK_MAX = 6

// 设置里存的可能是数字也可能是字符串；不是数就用默认值，超出范围的截到范围里
const numberOption = (v: unknown, fallback: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN

  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : fallback
}

export const readConfig = (o: PluginOptions): Config => ({
  loopFails: numberOption(o.loopFails, DEFAULT_CONFIG.loopFails, 100),
  loopEdits: numberOption(o.loopEdits, DEFAULT_CONFIG.loopEdits, 1000),
  limitAlert: typeof o.limitAlert === 'boolean' ? o.limitAlert : DEFAULT_CONFIG.limitAlert,
  forecastAfter: numberOption(o.forecastAfter, DEFAULT_CONFIG.forecastAfter, 90),
  compactTurns: numberOption(o.compactTurns, DEFAULT_CONFIG.compactTurns, 100),
  // 用 | 隔开；留空就不放
  quickPrompts:
    typeof o.quickPrompts === 'string'
      ? o.quickPrompts
          .split('|')
          .map(t => t.trim())
          .filter(Boolean)
          .slice(0, QUICK_MAX)
      : DEFAULT_CONFIG.quickPrompts,
  keepWarmTimes: numberOption(o.keepWarmTimes, DEFAULT_CONFIG.keepWarmTimes, 10),
})

export const forecastShare = () => config.forecastAfter / 100
