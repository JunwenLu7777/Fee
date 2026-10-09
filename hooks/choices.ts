import type { HudChoice } from '../types'

import { clip } from './format'

// 我回复里让你挑的编号选项：最后那一串从 1 开始连着的编号（1. 2. 3. 或者 1、2、），至少两项。
// 回复里还得有「挑号码」「可以多选」这类让你挑的话，免得把一般的步骤、要你帮忙看的清单也画成按钮

const ITEM = /^(\d{1,2})[.、)）]\s*(.+)$/
const CUES = ['挑号码', '挑一个', '挑几个', '挑哪', '选哪', '选几个', '可以多选', '哪几个', '回个数字', '回数字']
const LABEL_MAX = 20

// 「**先修缓存过期的判断（推荐）**：订阅账号…」→ 先修缓存过期的判断：有加粗的取加粗的，再取第一个逗号、冒号前面
const labelOf = (text: string) => {
  const bold = text.match(/^\*\*(.+?)\*\*/)?.[1]
  const head = (bold ?? text).split(/[：:，,。；;]/)[0] ?? text
  const plain = head
    .replace(/[`*]/g, '')
    .replace(/(（[^）]*）|\([^)]*\))\s*$/, '')
    .trim()

  return clip(plain || text.trim(), LABEL_MAX)
}

export const parseChoices = (text: string): HudChoice[] => {
  if (!CUES.some(c => text.includes(c))) {
    return []
  }
  let run: HudChoice[] = []
  let last: HudChoice[] = []
  for (const line of text.split('\n')) {
    const m = line.match(ITEM)
    if (m) {
      const n = Number(m[1])
      const item = { n, label: labelOf(m[2] ?? '') }
      run = n === 1 ? [item] : n === run.length + 1 ? [...run, item] : []
      if (run.length >= 2) {
        last = run
      }
    } else if (line.trim() !== '' && !/^\s/.test(line)) {
      // 空行、缩进的续行和子项不打断；顶格的别的话（下一段、标题）打断
      run = []
    }
  }

  return last
}

// 你点的编号连成要发的话，按点的先后：都是一位数就连着写（15、1423），有两位数的用顿号隔开
export const choiceText = (picked: readonly number[]) => picked.join(picked.every(n => n < 10) ? '' : '、')

// 排成整齐的几列：每格 cellWidth 宽，列和列之间空 gap 格，一行放得下几格放几格
export const gridOf = <T>(items: readonly T[], cellWidth: number, width: number, gap: number): T[][] => {
  const cols = Math.max(1, Math.floor((width + gap) / (cellWidth + gap)))

  return Array.from({ length: Math.ceil(items.length / cols) }, (_, r) => items.slice(r * cols, (r + 1) * cols))
}
