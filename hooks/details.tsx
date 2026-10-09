import type { Elements, RenderElement } from 'claude-code'

import type {
  HudActivity,
  HudAgent,
  HudCacheMiss,
  HudContextParts,
  HudDaily,
  HudDetailsTab,
  HudDetailsView,
  HudFileEdit,
  HudReceipt,
  HudStats,
  HudTokens,
  HudToolCall,
  HudToolSort,
  HudToolStat,
  HudTurn,
  HudTurnSort,
} from '../types'

import { clip, dayKey, formatElapsed, formatMs, formatSpan, formatTokens, formatUsd, padEnd, padStart, weekdayOf } from './format'
import { commandLabel, contextGrowth, isLive, sumLines } from './ledger'
import type { CompactForecast } from './ledger'
import { isUnpriced, lastDays, projectName, spentByProject, spentOn } from './spend'
import { partName } from './context'

// 点 HUD 最前面的 ▸ 在 HUD 下方展开的明细，和每轮结尾那行下面的小票。
// 这块在输入框下面，只能点不能打字：排序、翻页、选中、展开都是按钮

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type Piece = { text: string; color?: string; dim?: boolean }

const SEP: Piece = { text: ' · ', dim: true }

const join = (groups: Piece[][]) => groups.flatMap((g, i) => (i ? [SEP, ...g] : g))

// ---------- 每轮结尾那行下面的小票 ----------

const baseName = (path: string) => path.split('/').pop() ?? path

// 加的行绿色、删的行红色，和 git 一样
const linesPieces = (added: number, removed: number): Piece[] =>
  added || removed
    ? [
        { text: ` +${added}`, color: 'green' },
        { text: ` -${removed}`, color: 'red' },
      ]
    : []

// 改了一两个文件就写名字，多了只写个数
const filesPieces = (files: readonly HudFileEdit[]): Piece[] => {
  const { added, removed } = sumLines(files)
  const names = files.length <= 2 ? files.map(f => baseName(f.path)).join('、') : `${files.length} 个文件`

  return [{ text: `改 ${names}`, dim: true }, ...linesPieces(added, removed)]
}

const commandsPieces = (r: HudReceipt): Piece[] =>
  r.failed
    ? [
        { text: `${r.commands} 条命令，`, dim: true },
        { text: `${r.failed} 条失败`, color: 'red' },
      ]
    : [{ text: `${r.commands} 条命令`, dim: true }]

// 缓存没接上，这一轮的花费多半就高在这：换了模型的直说，别的是模型闲太久过期了
const cacheMissPieces = (m: HudCacheMiss): Piece[] => [
  { text: m.isNewModel ? `换了模型，缓存重算 ${formatTokens(m.tokens)}` : `缓存过期，重算 ${formatTokens(m.tokens)}`, color: 'yellow' },
]

// 明细里那一轮下面的一句话
const cacheMissText = (m: HudCacheMiss) =>
  m.isNewModel
    ? `换了模型，缓存接不上，${formatTokens(m.tokens)} 上下文重新算了一遍`
    : `模型闲了 ${formatSpan(m.idleMs)}，缓存多半过期了，${formatTokens(m.tokens)} 上下文重新算了一遍`

// $0.27 · 缓存过期，重算 85k · 改 a.ts +2 -1 · 5 条命令，1 条失败 · 2 个子 agent；没什么可说的就是空的
export const receiptPieces = (r: HudReceipt): Piece[] =>
  join([
    ...(r.costUsd != null && r.costUsd >= 0.005 ? [[{ text: formatUsd(r.costUsd), color: 'yellow' }]] : []),
    ...(r.cacheMiss ? [cacheMissPieces(r.cacheMiss)] : []),
    ...(r.files.length ? [filesPieces(r.files)] : []),
    ...(r.commands ? [commandsPieces(r)] : []),
    ...(r.agents ? [[{ text: `${r.agents} 个子 agent`, dim: true }]] : []),
  ])

// ---------- 明细 ----------

export type DetailsData = {
  view: HudDetailsView
  turns: readonly HudTurn[]
  // 正在跑的这一轮，没在跑时为 null
  live: HudActivity | null
  tools: readonly HudToolStat[]
  calls: readonly HudToolCall[]
  agents: readonly HudAgent[]
  stats: HudStats | null
  tokens: HudTokens | null
  now: number
  // ccusage 算的每天花费；还没算过为 null
  daily: HudDaily | null
  // 会话目录，认出哪个项目是当前的
  cwd: string
  // 照现在的速度重置前就会用完的额度，一条一句话
  alerts: { text: string; isUrgent: boolean }[]
  // 本地时区相对 UTC 的分钟数
  offset: number
  // 现在上下文有多少 token、到多少自动压缩、照最近几轮的涨法还能撑几轮
  context: number | null
  compactAt: number | null
  compact: CompactForecast | null
  // 上下文里装了什么；还没估过为 null
  contextParts: HudContextParts | null
}

// 点了什么就改一下明细的状态
export type ChangeView = (change: (view: HudDetailsView) => HudDetailsView) => void

export type DetailsActions = {
  setView: ChangeView
  // 点「刷新」马上重新用 ccusage 算每天花费
  refreshDaily: () => void
  // 点失败的命令，把它放进输入框
  fillPrompt: (text: string) => void
  // 点「刷新」马上重新估上下文里装了什么
  refreshContext: () => void
  // 在侧边栏里看这一轮的改动
  openChanges: (turnId: string) => void
}

const TABS: { id: HudDetailsTab; label: string }[] = [
  { id: 'turns', label: '轮次' },
  { id: 'tools', label: '工具耗时' },
  { id: 'context', label: '上下文' },
  { id: 'agents', label: '子 agent' },
  { id: 'spend', label: '每天花费' },
]

// 三张卡片并排：轮次 62、工具耗时 60、子 agent 占剩下的（至少 36）；不够就改成点标签切换
const TURNS_WIDTH = 62
const TOOLS_WIDTH = 60
const AGENTS_MIN_WIDTH = 36
const CARD_GAP = 1
// 卡片的边框和左右各一格留白
const CARD_CHROME = 4
export const SIDE_BY_SIDE_MIN = TURNS_WIDTH + TOOLS_WIDTH + AGENTS_MIN_WIDTH + CARD_GAP * 2

// 轮次多了才画趋势，两三轮看不出什么
const TREND_MIN_TURNS = 5
const BAR_WIDTH = 8
// 轮次表多了一列 ctx，横条让出一格
const TURN_BAR_WIDTH = 7
const SPARKS = '▁▂▃▄▅▆▇█'
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const FILES_SHOWN = 3
const FAILED_SHOWN = 2
const SLOWEST_SHOWN = 5
const REPORT_LINES = 6
const PROMPT_LINES = 3
// 每天花费列最近几天
const DAYS_SHOWN = 7

// 一串数画成一行小柱子，最高的那根顶格
const sparkline = (values: readonly number[]) => {
  const max = Math.max(0, ...values)

  return values.map(v => SPARKS[max > 0 ? Math.min(7, Math.floor((v / max) * 7.999)) : 0]).join('')
}

// 横条：最大的那个占满 width 格，按八分之一格画细，有一点就至少画一细条
const barOf = (value: number, max: number, width: number) => {
  if (max <= 0 || value <= 0) {
    return ''
  }
  const units = Math.max(1, Math.round((value / max) * width * 8))

  return '█'.repeat(Math.floor(units / 8)) + (EIGHTHS[units % 8] ?? '')
}

const inputOf = (t: HudTokens | null) => (t ? t.input + t.cacheRead + t.cacheWrite : 0)

const cacheHit = (t: HudTokens | null) => {
  const total = inputOf(t)

  return t && total ? `${Math.round((t.cacheRead / total) * 100)}%` : '-'
}

// 标签暗、数值亮：本会话 $1.50 · 2 轮 · in 30k
const facts = (pairs: readonly (readonly [string, string])[]): Piece[] =>
  join(pairs.map(([label, value]) => (label ? [{ text: `${label} `, dim: true }, { text: value }] : [{ text: value }])))

const REASON: Record<string, string> = { answer: '正常结束', aborted: '被中断', refusal: '被拒绝', error: '出错' }

const STATUS: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
  waiting: '等待中',
  idle: '空闲',
  completed: '已完成',
  failed: '失败',
  killed: '已停止',
}

// 多行文字只留前几行，每行截到 width
const firstLines = (text: string, lines: number, width: number) => {
  const all = text.split('\n').filter(l => l.trim() !== '')
  const shown = all.slice(0, lines).map(l => clip(l, width))

  return all.length > lines ? [...shown, '…'] : shown
}

// 表格里的一行：跑完的轮次，或者正在跑的这一轮
type TurnRow = {
  turnId: string
  index: number | null
  startedAt: number
  durationMs: number
  isRunning: boolean
  tools: number
  reason: string | null
  receipt: HudReceipt
  contextAtStart: number | null
  contextAtEnd: number | null
  isCompacted: boolean
}

// 热重载前记下的轮次没有上下文
const rowOfTurn = (t: HudTurn): TurnRow => ({
  ...t,
  isRunning: false,
  contextAtStart: t.contextAtStart ?? null,
  contextAtEnd: t.contextAtEnd ?? null,
  isCompacted: t.isCompacted ?? false,
})

// 正在跑的这一轮，上下文涨到现在的
const rowOfLive = (a: HudActivity, context: number | null): TurnRow => ({
  turnId: a.turnId,
  index: a.index,
  startedAt: a.startedAt,
  durationMs: a.elapsedMs,
  isRunning: true,
  tools: a.tools,
  reason: null,
  receipt: a.receipt,
  contextAtStart: a.contextAtStart ?? null,
  contextAtEnd: context,
  isCompacted: a.isCompacted ?? false,
})

// +12k；压缩过的写「压缩」
const growthText = (r: TurnRow) => {
  if (r.isCompacted) {
    return '压缩'
  }
  const g = contextGrowth(r)

  return g == null ? '-' : g >= 0 ? `+${formatTokens(g)}` : `-${formatTokens(-g)}`
}

const turnNo = (r: TurnRow) => (r.index != null ? `#${r.index}` : '#?')

// 轮次能按这几列排；最近的在前时，横条画花费
const TURN_METRIC: Record<Exclude<HudTurnSort, 'recent'>, (r: TurnRow) => number> = {
  duration: r => r.durationMs,
  cost: r => r.receipt.costUsd ?? 0,
  input: r => inputOf(r.receipt.tokens),
  output: r => r.receipt.tokens?.output ?? 0,
  context: r => Math.max(0, contextGrowth(r) ?? 0),
}

const TOOL_METRIC: Record<HudToolSort, (s: HudToolStat) => number> = {
  total: s => s.totalMs,
  count: s => s.count,
  avg: s => s.totalMs / s.count,
  max: s => s.maxMs,
  failed: s => s.failed,
}

const statusIcon = (a: HudAgent): Piece =>
  isLive(a)
    ? { text: '●', color: 'yellow' }
    : a.status === 'completed'
      ? { text: '✓', color: 'green' }
      : a.status === 'failed'
        ? { text: '✗', color: 'red' }
        : { text: '■', dim: true }

// 一列：表头、多宽、左右对齐、能不能点了排序
type Col<T, S> = {
  title: string
  width: number
  isRight?: boolean
  sort?: S
  cell: (row: T) => Piece
}

const align = (text: string, width: number, isRight?: boolean) =>
  isRight ? padStart(text, width) : padEnd(text, width)

// 上下文 720k · 到 920k 自动压缩 · 每轮约 +40k · 约 5 轮后压缩
const compactLine = (context: number, at: number, c: CompactForecast | null): Piece[] => [
  { text: '上下文 ', dim: true },
  { text: formatTokens(context) },
  SEP,
  { text: `到 ${formatTokens(at)} 自动压缩`, dim: true },
  ...(c
    ? [
        SEP,
        { text: `每轮约 +${formatTokens(Math.round(c.perTurn))}`, dim: true },
        SEP,
        {
          text: c.turnsLeft === 0 ? '下一轮就可能压缩' : `约 ${c.turnsLeft} 轮后压缩`,
          ...(c.turnsLeft <= 1 ? { color: 'red' } : c.turnsLeft <= 3 ? { color: 'yellow' } : {}),
        },
      ]
    : []),
]

export const drawDetails = (
  ui: Ui,
  data: DetailsData,
  size: { columns: number; rows: number },
  actions: DetailsActions,
): RenderElement => {
  const { Box, Text, Button } = ui
  const { view } = data
  const patch = (next: Partial<HudDetailsView>) => actions.setView(v => ({ ...v, ...next }))
  const paint = (p: Piece) => (
    <Text {...(p.color ? { color: p.color } : {})} {...(p.dim ? { dimColor: true } : {})}>
      {p.text}
    </Text>
  )
  const line = (pieces: readonly Piece[], extra: { bold?: boolean } = {}) => (
    <Text wrap="truncate-end" {...(extra.bold ? { bold: true } : {})}>
      {pieces.map(paint)}
    </Text>
  )
  const note = (text: string) => <Text dimColor>{text}</Text>
  // 暗色的小按钮：翻页、展开、收起
  const link = (key: string, label: string, onPress: () => void) => (
    <Button key={key} plain dimColor onPress={onPress}>
      {label}
    </Button>
  )

  // 表头：能排序的列是按钮，正在按它排的那列亮着、带 ↓
  const header = <T, S extends string>(cols: readonly Col<T, S>[], active: S, onSort: (sort: S) => void, prefix: string) => (
    <Box columnGap={1} marginTop={1}>
      {cols.map(c =>
        c.sort ? (
          <Button
            key={`${prefix}:${c.sort}`}
            plain
            {...(c.sort === active ? {} : { dimColor: true })}
            onPress={() => onSort(c.sort as S)}
          >
            {align(c.sort === active ? `${c.title}↓` : c.title, c.width, c.isRight)}
          </Button>
        ) : (
          <Text dimColor>{align(c.title, c.width, c.isRight)}</Text>
        ),
      )}
    </Box>
  )

  // 一行：前面几列合成一个按钮（点整行就是选中它），后面带颜色的几列照常画
  const row = <T, S>(
    key: string,
    cols: readonly Col<T, S>[],
    clickable: number,
    item: T,
    isPicked: boolean,
    onPress: () => void,
  ) => {
    const pieces = cols.map(c => {
      const p = c.cell(item)

      return { ...p, text: align(p.text, c.width, c.isRight) }
    })
    const label = pieces
      .slice(0, clickable)
      .map(p => p.text)
      .join(' ')
    const rest = pieces.slice(clickable).flatMap(p => [{ text: ' ' }, p])

    return (
      <Box>
        <Button key={key} plain {...(isPicked ? {} : { dimColor: true })} onPress={onPress}>
          {label}
        </Button>
        {line(rest)}
      </Box>
    )
  }

  // ---------- 轮次 ----------

  const turnsBody = (width: number, rows: number) => {
    const latest = [...(data.live ? [rowOfLive(data.live, data.context)] : []), ...data.turns.map(rowOfTurn).reverse()]
    if (latest.length === 0) {
      return note('还没有跑完的轮次。')
    }
    const metric = view.turnSort === 'recent' ? TURN_METRIC.cost : TURN_METRIC[view.turnSort]
    const sorted = view.turnSort === 'recent' ? latest : [...latest].sort((a, b) => metric(b) - metric(a))
    const pageSize = Math.max(3, Math.min(8, rows - 11))
    const pages = Math.ceil(sorted.length / pageSize)
    const page = Math.min(view.page, pages - 1)
    const shown = sorted.slice(page * pageSize, (page + 1) * pageSize)
    const picked = sorted.find(r => r.turnId === view.turn) ?? shown[0]
    const maxMetric = Math.max(0, ...shown.map(metric))
    const isWide = width >= 54
    const hasBar = width >= 42
    const cols: Col<TurnRow, HudTurnSort>[] = [
      {
        title: '轮',
        width: 6,
        sort: 'recent',
        cell: r => ({ text: `${r.turnId === picked?.turnId ? '❯' : ' '} ${turnNo(r)}` }),
      },
      {
        title: '用时',
        width: 6,
        isRight: true,
        sort: 'duration',
        cell: r => ({ text: r.isRunning ? '…' : formatElapsed(r.durationMs) }),
      },
      {
        title: '花费',
        width: 7,
        isRight: true,
        sort: 'cost',
        cell: r => ({ text: r.receipt.costUsd != null ? formatUsd(r.receipt.costUsd) : '-' }),
      },
      ...(hasBar
        ? [
            {
              title: '',
              width: TURN_BAR_WIDTH,
              cell: (r: TurnRow) => ({ text: barOf(metric(r), maxMetric, TURN_BAR_WIDTH), color: 'yellow' }),
            },
          ]
        : []),
      ...(isWide
        ? [
            {
              title: 'in',
              width: 5,
              isRight: true,
              sort: 'input' as const,
              // 缓存没接上的轮次 in 标黄
              cell: (r: TurnRow) => ({
                text: formatTokens(inputOf(r.receipt.tokens)),
                ...(r.receipt.cacheMiss ? { color: 'yellow' } : {}),
              }),
            },
            {
              title: 'out',
              width: 5,
              isRight: true,
              sort: 'output' as const,
              cell: (r: TurnRow) => ({ text: formatTokens(r.receipt.tokens?.output ?? 0) }),
            },
            // 这一轮让上下文涨了多少
            {
              title: 'ctx',
              width: 5,
              isRight: true,
              sort: 'context' as const,
              cell: (r: TurnRow) => ({ text: growthText(r), ...(r.isCompacted ? { dim: true } : {}) }),
            },
          ]
        : []),
      ...(hasBar
        ? [
            {
              title: '文件',
              width: 4,
              isRight: true,
              cell: (r: TurnRow) => ({ text: r.receipt.files.length ? String(r.receipt.files.length) : '-' }),
            },
          ]
        : []),
      {
        title: '命令',
        width: 5,
        isRight: true,
        cell: r => {
          const { commands, failed } = r.receipt

          return { text: commands ? `${commands}${failed ? ` ✗${failed}` : ''}` : '-', ...(failed ? { color: 'red' } : {}) }
        },
      },
    ]
    const total = data.stats?.costUsd
    // 趋势只画跑完的轮次，最近的在右边
    const recent = data.turns.slice(-Math.max(4, width - 22))
    const costs = recent.map(t => t.receipt.costUsd ?? 0)

    return (
      <Box flexDirection="column">
        {line(
          facts([
            ...(total != null ? [['本会话', formatUsd(total)] as const] : []),
            ['', `${data.turns.length} 轮`],
            ['in', formatTokens(inputOf(data.tokens))],
            ['out', formatTokens(data.tokens?.output ?? 0)],
            ['缓存', cacheHit(data.tokens)],
          ]),
        )}
        {data.context != null && data.compactAt != null && line(compactLine(data.context, data.compactAt, data.compact))}
        {recent.length >= TREND_MIN_TURNS &&
          line([
            { text: '趋势 ', dim: true },
            { text: sparkline(costs), color: 'yellow' },
            { text: ` 最近 ${recent.length} 轮花费，最高 ${formatUsd(Math.max(...costs))}`, dim: true },
          ])}
        {header(cols, view.turnSort, sort => patch({ turnSort: sort, page: 0 }), 'sort-turn')}
        {shown.map(r =>
          row(`turn:${r.turnId}`, cols, 3, r, r.turnId === picked?.turnId, () =>
            patch({ turn: r.turnId, isTurnFull: false }),
          ),
        )}
        {pages > 1 && (
          <Box columnGap={2}>
            {page > 0 ? link('page:prev', '‹ 上一页', () => patch({ page: page - 1 })) : note('‹ 上一页')}
            {note(`${page + 1}/${pages}`)}
            {page < pages - 1 ? link('page:next', '下一页 ›', () => patch({ page: page + 1 })) : note('下一页 ›')}
          </Box>
        )}
        {picked && turnDetail(picked, width)}
      </Box>
    )
  }

  // 选中那一轮：改了哪些文件、哪些命令失败了；多了可以点开看全部
  const turnDetail = (r: TurnRow, width: number) => {
    const rec = r.receipt
    const head = [
      turnNo(r),
      r.isRunning ? `进行中 ${formatElapsed(r.durationMs)}` : formatElapsed(r.durationMs),
      ...(rec.costUsd != null ? [formatUsd(rec.costUsd)] : []),
      ...(r.reason && r.reason !== 'answer' ? [REASON[r.reason] ?? r.reason] : []),
    ].join(' · ')
    // 路径再长也只占这么宽，免得窄窗口一张卡片铺满时 +/- 被推到最右边
    const nameWidth = Math.max(8, Math.min(44, width - 14))
    const files = view.isTurnFull ? rec.files : rec.files.slice(0, FILES_SHOWN)
    const failed = view.isTurnFull ? rec.failedCommands : rec.failedCommands.slice(-FAILED_SHOWN)
    const hidden = rec.files.length - files.length + (rec.failedCommands.length - failed.length)

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold wrap="truncate-end">{head}</Text>
        {line(
          facts([
            ['in', formatTokens(inputOf(rec.tokens))],
            ['out', formatTokens(rec.tokens?.output ?? 0)],
            ['缓存', cacheHit(rec.tokens)],
            ['工具', `${r.tools} 次`],
            ['上下文', r.isCompacted ? '压缩过' : growthText(r)],
            ...(rec.agents ? [['子 agent', `${rec.agents} 个`] as const] : []),
          ]),
        )}
        {rec.cacheMiss && line([{ text: cacheMissText(rec.cacheMiss), color: 'yellow' }])}
        {rec.files.length > 0 && (
          <Box columnGap={1}>
            {note(`改了 ${rec.files.length} 个文件`)}
            {link('changes:open', '在侧边栏看 ›', () => actions.openChanges(r.turnId))}
          </Box>
        )}
        {files.map(f => line([{ text: `  ${padEnd(f.path, nameWidth)}` }, ...linesPieces(f.added, f.removed)]))}
        {rec.commands > 0 &&
          line([
            { text: `跑了 ${rec.commands} 条命令`, dim: true },
            ...(rec.failed ? [{ text: `，${rec.failed} 条失败`, color: 'red' }] : []),
            ...(failed.length ? [{ text: '（点一条放进输入框）', dim: true }] : []),
          ])}
        {failed.map((c, i) => (
          <Box>
            <Text color="red">{'  ✗ '}</Text>
            <Button key={`fail:${i}`} plain onPress={() => actions.fillPrompt(c)}>
              {clip(commandLabel(c), Math.max(8, width - 4))}
            </Button>
          </Box>
        ))}
        {hidden > 0 && link('turn:more', `  … 展开全部（还有 ${hidden} 条）`, () => patch({ isTurnFull: true }))}
        {view.isTurnFull &&
          (rec.files.length > FILES_SHOWN || rec.failedCommands.length > FAILED_SHOWN) &&
          link('turn:less', '  收起', () => patch({ isTurnFull: false }))}
      </Box>
    )
  }

  // ---------- 工具耗时 ----------

  const toolsBody = (width: number, rows: number) => {
    if (data.tools.length === 0) {
      return note('还没有工具调用。')
    }
    const metric = TOOL_METRIC[view.toolSort]
    const sorted = [...data.tools].sort((a, b) => metric(b) - metric(a) || b.totalMs - a.totalMs)
    const calls = sorted.reduce((n, s) => n + s.count, 0)
    const spent = sorted.reduce((n, s) => n + s.totalMs, 0)
    const failed = sorted.reduce((n, s) => n + s.failed, 0)
    const maxMetric = Math.max(0, ...sorted.map(metric))
    const picked = sorted.find(s => s.name === view.tool) ?? null
    const cols: Col<HudToolStat, HudToolSort>[] = [
      {
        title: '工具',
        width: Math.max(6, width - 43),
        cell: s => ({ text: `${s.name === picked?.name ? '❯' : ' '} ${s.name}` }),
      },
      { title: '', width: BAR_WIDTH, cell: s => ({ text: barOf(metric(s), maxMetric, BAR_WIDTH), color: 'cyan' }) },
      { title: '总耗时', width: 7, isRight: true, sort: 'total', cell: s => ({ text: formatMs(s.totalMs) }) },
      { title: '次数', width: 5, isRight: true, sort: 'count', cell: s => ({ text: String(s.count) }) },
      { title: '平均', width: 6, isRight: true, sort: 'avg', cell: s => ({ text: formatMs(s.totalMs / s.count) }) },
      { title: '最长', width: 6, isRight: true, sort: 'max', cell: s => ({ text: formatMs(s.maxMs) }) },
      {
        title: '失败',
        width: 5,
        isRight: true,
        sort: 'failed',
        cell: s => ({ text: s.failed ? String(s.failed) : '-', ...(s.failed ? { color: 'red' } : {}) }),
      },
    ]
    const shown = sorted.slice(0, Math.max(3, rows - (picked ? 4 + SLOWEST_SHOWN : 4)))

    return (
      <Box flexDirection="column">
        {line([
          ...facts([
            ['调用', `${calls} 次`],
            ['共', formatMs(spent)],
          ]),
          ...(failed ? [SEP, { text: `失败 ${failed} 次`, color: 'red' }] : []),
        ])}
        {header(cols, view.toolSort, sort => patch({ toolSort: sort }), 'sort-tool')}
        {shown.map(s =>
          row(`tool:${s.name}`, cols, 1, s, s.name === picked?.name, () =>
            patch({ tool: s.name === view.tool ? null : s.name }),
          ),
        )}
        {sorted.length > shown.length && note(`  …还有 ${sorted.length - shown.length} 种`)}
        {picked && slowest(picked, width)}
      </Box>
    )
  }

  // 选中的工具最慢的几次：跑的什么命令、读写的什么文件、在第几轮
  const slowest = (tool: HudToolStat, width: number) => {
    const list = data.calls
      .filter(c => c.tool === tool.name)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, SLOWEST_SHOWN)

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{`${tool.name} · 最慢的 ${list.length} 次`}</Text>
        {list.length === 0 && note('  这次启动以来没有记录。')}
        {list.map(c =>
          line([
            { text: '  ' },
            { text: padStart(formatMs(c.ms), 6) },
            { text: ` ${padEnd(c.turnIndex != null ? `#${c.turnIndex}` : '', 4)} `, dim: true },
            ...(c.failed ? [{ text: '✗ ', color: 'red' }] : []),
            { text: clip(c.label || '（没有参数）', Math.max(8, width - 16 - (c.failed ? 2 : 0))) },
          ]),
        )}
      </Box>
    )
  }

  // ---------- 子 agent ----------

  const agentsBody = (width: number, rows: number) => {
    if (data.agents.length === 0) {
      return note('这次会话还没有子 agent。')
    }
    const running = data.agents.filter(isLive).length
    const latest = [...data.agents].reverse()
    const shown = latest.slice(0, Math.max(1, Math.floor((rows - 2) / 2)))

    return (
      <Box flexDirection="column">
        {line(
          facts([
            ['共', `${data.agents.length} 个`],
            ...(running ? [['运行中', `${running} 个`] as const] : []),
          ]),
        )}
        {shown.map(a => {
          const spent = (a.endedAt ?? data.now) - a.startedAt
          const isOpen = view.agent === a.id

          return (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                {paint(statusIcon(a))}
                <Text> </Text>
                <Button
                  key={`agent:${a.id}`}
                  plain
                  {...(isOpen ? {} : { dimColor: true })}
                  onPress={() => patch({ agent: isOpen ? null : a.id })}
                >
                  {clip(`${a.type} · ${a.description}`, Math.max(8, width - 2))}
                </Button>
              </Box>
              {line([
                { text: '  ' },
                ...facts([
                  [isLive(a) ? '运行中' : '用时', formatElapsed(spent)],
                  ['工具', `${a.tools} 次`],
                  ...(a.tokens
                    ? [['in', formatTokens(inputOf(a.tokens))] as const, ['out', formatTokens(a.tokens.output)] as const]
                    : []),
                  ...(a.turnIndex != null ? [['第', `${a.turnIndex} 轮`] as const] : []),
                ]),
              ])}
              {isOpen && agentDetail(a, width)}
            </Box>
          )
        })}
        {latest.length > shown.length && note(`  …还有 ${latest.length - shown.length} 个`)}
      </Box>
    )
  }

  // 点开的子 agent：模型、状态、交给它的任务、它交回来的报告
  const agentDetail = (a: HudAgent, width: number) => (
    <Box flexDirection="column" paddingLeft={2}>
      {line(
        facts([
          ['模型', a.model ?? '-'],
          ['状态', STATUS[a.status] ?? a.status],
        ]),
      )}
      {a.prompt && note('任务')}
      {a.prompt && firstLines(a.prompt, PROMPT_LINES, width - 4).map(l => <Text wrap="truncate-end">{`  ${l}`}</Text>)}
      {note('报告')}
      {a.report
        ? firstLines(a.report, REPORT_LINES, width - 4).map(l => <Text wrap="truncate-end">{`  ${l}`}</Text>)
        : note('  还没有交回报告。')}
    </Box>
  )

  // ---------- 上下文里装了什么 ----------

  // 占着窗口的几块从大到小一行一根横条，下面是 MCP 按服务器、记忆文件各占多少；返回画出来的内容和占几行
  const contextBody = (width: number, rows: number): { body: RenderElement; height: number } => {
    const c = data.contextParts
    if (!c) {
      return { body: note('还没估过上下文里装了什么，跑完一轮就有。'), height: 1 }
    }
    const used = c.parts.reduce((n, p) => n + p.tokens, 0)
    const max = Math.max(0, ...c.parts.map(p => p.tokens))
    const nameWidth = 12
    const barWidth = Math.max(4, Math.min(20, width - nameWidth - 9))
    const extras = (c.mcp.length ? 1 : 0) + (c.memory.length ? 1 : 0) + (c.deferred ? 1 : 0)
    const fits = Math.max(3, rows - 2 - extras)
    // 放不下时最后一行写还有几块，不悄悄藏起来
    const shown = c.parts.length > fits ? c.parts.slice(0, fits - 1) : c.parts
    const hidden = c.parts.slice(shown.length)
    // 只列前几个，后面的写个数
    const top = (list: readonly { name: string; tokens: number }[], room: number) => {
      const named = list.slice(0, 3).map(p => `${p.name} ${formatTokens(p.tokens)}`)
      const rest = list.length - named.length

      return clip([...named, ...(rest > 0 ? [`另外 ${rest} 个`] : [])].join(' · '), room)
    }
    const ago = data.now - c.at < 60_000 ? '刚刚估的' : `${formatSpan(data.now - c.at)}前估的`

    return {
      body: (
        <Box flexDirection="column">
          {line(facts([['占着窗口', formatTokens(used)], ...(data.compactAt ? [['到', `${formatTokens(data.compactAt)} 自动压缩`] as const] : [])]))}
          {shown.map(p =>
            line([
              { text: `${padEnd(partName(p.name), nameWidth)} `, dim: true },
              { text: padEnd(barOf(p.tokens, max, barWidth), barWidth), color: 'blue' },
              { text: ` ${padStart(formatTokens(p.tokens), 6)}` },
            ]),
          )}
          {hidden.length > 0 &&
            note(`…还有 ${hidden.length} 块，一共 ${formatTokens(hidden.reduce((n, p) => n + p.tokens, 0))}`)}
          {c.mcp.length > 0 && line([{ text: 'MCP：', dim: true }, { text: top(c.mcp, width - 5) }])}
          {c.memory.length > 0 && line([{ text: '记忆文件：', dim: true }, { text: top(c.memory, width - 10) }])}
          {c.deferred > 0 && note(`按需才加载的工具说明 ${formatTokens(c.deferred)}，平时不占窗口`)}
          <Box columnGap={1}>
            {note(`估算 · ${ago}`)}
            {link('context:refresh', '刷新', actions.refreshContext)}
          </Box>
        </Box>
      ),
      height: 2 + shown.length + (hidden.length ? 1 : 0) + extras,
    }
  }

  // ---------- 每天花费 ----------

  // 照现在的速度重置前就会用完的额度，写在每天花费最上面；返回画出来的内容和占几行
  const spendBody = (width: number, rows: number): { body: RenderElement; height: number } => {
    const alerts = data.alerts
    const alertLines = alerts.map(a => <Text color={a.isUrgent ? 'red' : 'yellow'}>{a.text}</Text>)
    const d = data.daily
    if (!d || (d.days.length === 0 && d.fetchedAt == null)) {
      const text =
        d?.error === 'missing'
          ? '没找到 ccusage，装上（npm i -g ccusage）就能看每天花了多少。'
          : d?.error
            ? `ccusage 没算成：${d.error}`
            : '正在用 ccusage 算每天花了多少，第一次要几秒…'

      return {
        body: (
          <Box flexDirection="column">
            {alertLines}
            {note(text)}
            {d?.error && !d.isRunning && link('spend:refresh', '再试一次', actions.refreshDaily)}
          </Box>
        ),
        height: alerts.length + 2,
      }
    }
    const today = dayKey(data.now, data.offset)
    const unpriced = isUnpriced(d.days)
    const count = Math.max(3, Math.min(DAYS_SHOWN, rows - alerts.length - 3 - (unpriced ? 1 : 0)))
    const dates = lastDays(today, count)
    const costOf = new Map(d.days.map(x => [x.date, x.costUsd]))
    const max = Math.max(0, ...dates.map(k => costOf.get(k) ?? 0))
    const barWidth = Math.max(4, Math.min(24, width - 20))
    const byProject = view.spendBy === 'project'
    // 按天看、按项目看，点着切换
    const switcher = (
      <Box columnGap={2}>
        {(['day', 'project'] as const).map(by => (
          <Button
            key={`spend:${by}`}
            plain
            {...(view.spendBy === by ? {} : { dimColor: true })}
            onPress={() => patch({ spendBy: by })}
          >
            {`${view.spendBy === by ? '▸' : ' '} ${by === 'day' ? '按天' : '近 7 天按项目'}`}
          </Button>
        ))}
      </Box>
    )
    // 近 7 天每个项目花了多少，多的在前；当前项目标出来；放不下的合成一行
    const projectRows = () => {
      if (d.projects.length === 0) {
        return [note('还没有按项目的数，下次刷新就有。')]
      }
      const list = spentByProject(d.projects, lastDays(today, 7))
      const top = list.slice(0, count)
      const topMax = Math.max(0, ...top.map(p => p.costUsd))
      const nameWidth = Math.max(8, Math.min(24, width - 4 - 9 - 10))
      const rest = list.slice(top.length)
      const restCost = rest.reduce((n, p) => n + p.costUsd, 0)

      return [
        ...top.map(p => {
          const { name, isCurrent } = projectName(p.project, data.cwd)

          return line([
            { text: `${padEnd(isCurrent ? `${name}（当前）` : name, nameWidth)} `, ...(isCurrent ? {} : { dim: true }) },
            { text: padEnd(barOf(p.costUsd, topMax, 10), 10), color: 'yellow' },
            { text: ` ${padStart(formatUsd(p.costUsd), 8)}` },
          ])
        }),
        ...(rest.length ? [note(`…还有 ${rest.length} 个项目 ${formatUsd(restCost)}`)] : []),
      ]
    }
    const ago = d.fetchedAt == null ? '' : data.now - d.fetchedAt < 60_000 ? '刚刚算的' : `${formatSpan(data.now - d.fetchedAt)}前算的`

    return {
      body: (
        <Box flexDirection="column">
          {alertLines}
          {line(
            facts([
              ['今天', formatUsd(spentOn(d.days, [today]))],
              ['近 7 天', formatUsd(spentOn(d.days, lastDays(today, 7)))],
              ['近 30 天', formatUsd(spentOn(d.days, lastDays(today, 30)))],
            ]),
          )}
          {switcher}
          {byProject
            ? projectRows()
            : dates.map(k => {
                const cost = costOf.get(k) ?? 0
                const isToday = k === today

                return line([
                  { text: `${k.slice(5).replace('-', '/')} ${weekdayOf(k)} `, ...(isToday ? {} : { dim: true }) },
                  { text: padEnd(barOf(cost, max, barWidth), barWidth), color: 'yellow' },
                  { text: ` ${padStart(cost ? formatUsd(cost) : '-', 8)}`, ...(cost ? {} : { dim: true }) },
                ])
              })}
          {unpriced && note('有的天 ccusage 不认识模型的价格，记成了 $0，升级 ccusage 试试。')}
          <Box columnGap={1}>
            {note(['本机所有会话', 'ccusage', ago].filter(Boolean).join(' · '))}
            {d.isRunning ? note('正在刷新…') : link('spend:refresh', '刷新', actions.refreshDaily)}
          </Box>
          {d.error && !d.isRunning && note(`上次刷新没成：${d.error === 'missing' ? '没找到 ccusage' : d.error}`)}
        </Box>
      ),
      height: alerts.length + 3 + count + (unpriced ? 1 : 0) + (d.error ? 1 : 0),
    }
  }

  // 圆角框的卡片，标题加粗；宽度给数字就定宽，grow 占满剩下的，fit 按内容
  const card = (title: string | null, width: number | 'grow' | 'fit', body: RenderElement) => (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor
      paddingX={1}
      {...(typeof width === 'number' ? { width } : width === 'grow' ? { flexGrow: 1 } : {})}
    >
      {title && <Text bold>{title}</Text>}
      {body}
    </Box>
  )

  // 宽的时候三列：轮次；工具耗时下面是上下文；最右边一列上面是每天花费、下面是子 agent，一眼看完
  if (size.columns >= SIDE_BY_SIDE_MIN) {
    const rows = size.rows - 3
    const sideWidth = size.columns - TURNS_WIDTH - TOOLS_WIDTH - CARD_GAP * 2 - CARD_CHROME
    const spend = spendBody(sideWidth, rows - 4)
    const inside = contextBody(TOOLS_WIDTH - CARD_CHROME, Math.max(5, Math.floor(rows / 2)))

    return (
      <Box columnGap={CARD_GAP}>
        {card('轮次', TURNS_WIDTH, turnsBody(TURNS_WIDTH - CARD_CHROME, rows))}
        <Box flexDirection="column" width={TOOLS_WIDTH}>
          {card('工具耗时', 'fit', toolsBody(TOOLS_WIDTH - CARD_CHROME, Math.max(5, rows - inside.height - 3)))}
          {card('上下文', 'grow', inside.body)}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {card('每天花费', 'fit', spend.body)}
          {card('子 agent', 'grow', agentsBody(sideWidth, Math.max(3, rows - spend.height - 3)))}
        </Box>
      </Box>
    )
  }

  // 窄的时候点标签切换，只放一张卡片；标签就是标题，卡片里不再写一遍
  const width = Math.max(24, size.columns) - CARD_CHROME
  const rows = size.rows - 3
  const tab = TABS.find(t => t.id === view.tab) ?? TABS[0]!
  const tabs = (
    <Box columnGap={2}>
      {TABS.map(t => (
        <Button
          key={`tab:${t.id}`}
          plain
          {...(t.id === tab.id ? {} : { dimColor: true })}
          onPress={() => patch({ tab: t.id })}
        >
          {t.id === tab.id ? `▸ ${t.label}` : `  ${t.label}`}
        </Button>
      ))}
    </Box>
  )
  const body =
    tab.id === 'tools'
      ? toolsBody(width, rows)
      : tab.id === 'agents'
        ? agentsBody(width, rows)
        : tab.id === 'context'
          ? contextBody(width, rows).body
          : tab.id === 'spend'
          ? spendBody(width, rows).body
          : turnsBody(width, rows)

  return (
    <Box flexDirection="column">
      {tabs}
      {card(null, 'grow', body)}
    </Box>
  )
}
