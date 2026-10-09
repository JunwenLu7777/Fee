import type { Elements, RenderElement } from 'claude-code'

import type { HudChangesView, HudFileDiff, HudFileEdit } from '../types'

import { clipStart, padEnd } from './format'
import { sumLines } from './ledger'

// 改动侧边栏：这个会话改过的文件和各自 +N -M，点一个看它具体改了哪几行。全靠点：选文件、翻页

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type ChangesData = {
  // 拍得了 git 快照才看得了改动
  isTracked: boolean
  files: readonly HudFileEdit[]
  // 这一轮（在跑的，或者刚跑完的那轮）改过的文件，前面画个 ●
  turnFiles: ReadonlySet<string>
  view: HudChangesView
  diff: HudFileDiff | null
}

export type ChangesActions = {
  pick: (path: string) => void
  page: (page: number) => void
}

// 点开一个文件时，文件列表只留这么几行，剩下的给改动
const LIST_WHEN_OPEN = 6

// 改动的一行：加的绿、删的红、@@ 那行青色，没改的暗着
const lineColor = (line: string) =>
  line.startsWith('+') ? { color: 'green' } : line.startsWith('-') ? { color: 'red' } : line.startsWith('@@') ? { color: 'cyan' } : { dimColor: true }

export const drawChanges = (
  ui: Ui,
  data: ChangesData,
  size: { columns: number; rows: number },
  actions: ChangesActions,
): RenderElement => {
  const { Box, Text, Button } = ui
  if (!data.isTracked) {
    return <Text dimColor>不是 git 仓库（或者仓库太大），看不了改动。</Text>
  }
  if (data.files.length === 0) {
    return <Text dimColor>这个会话还没改过文件。</Text>
  }
  const width = Math.max(20, size.columns)
  const { added, removed } = sumLines(data.files)
  const picked = data.files.find(f => f.path === data.view.path) ?? null
  const hasTurnFiles = data.files.some(f => data.turnFiles.has(f.path))
  const room = picked ? LIST_WHEN_OPEN : Math.max(3, size.rows - 3)
  // 文件多了只列前面的；点开的那个排在后面也要留着
  const head = data.files.slice(0, room)
  const shown = picked && !head.includes(picked) ? [...head.slice(0, room - 1), picked] : head
  const numberWidth = Math.max(...shown.map(f => `+${f.added} -${f.removed}`.length)) + 1
  const nameWidth = Math.max(8, width - 4 - numberWidth)

  const fileRow = (f: HudFileEdit) => {
    const isPicked = f.path === picked?.path
    const mark = `${isPicked ? '❯' : ' '}${data.turnFiles.has(f.path) ? '●' : ' '} `

    return (
      <Box>
        <Button key={`file:${f.path}`} plain {...(isPicked ? {} : { dimColor: true })} onPress={() => actions.pick(f.path)}>
          {mark + padEnd(clipStart(f.path, nameWidth), nameWidth)}
        </Button>
        <Text>
          <Text color="green">{` +${f.added}`}</Text>
          <Text color="red">{` -${f.removed}`}</Text>
        </Text>
      </Box>
    )
  }

  // 点开的文件：会话开始到现在改了什么，一页一页翻
  const diffOf = (f: HudFileEdit) => {
    const diff = data.diff?.path === f.path ? data.diff : null
    if (!diff) {
      return <Text dimColor>正在读改动…</Text>
    }
    if (diff.lines.length === 0) {
      return <Text dimColor>现在和会话开始时一样，没有改动。</Text>
    }
    const pageSize = Math.max(5, size.rows - shown.length - 6)
    const pages = Math.ceil(diff.lines.length / pageSize)
    const page = Math.min(data.view.page, pages - 1)

    return (
      <Box flexDirection="column">
        {diff.lines.slice(page * pageSize, (page + 1) * pageSize).map(line => (
          <Text wrap="truncate-end" {...lineColor(line)}>
            {line || ' '}
          </Text>
        ))}
        {pages > 1 && (
          <Box columnGap={2}>
            {page > 0 ? (
              <Button key="diff:prev" plain dimColor onPress={() => actions.page(page - 1)}>
                ‹ 上一页
              </Button>
            ) : (
              <Text dimColor>‹ 上一页</Text>
            )}
            <Text dimColor>{`${page + 1}/${pages}`}</Text>
            {page < pages - 1 ? (
              <Button key="diff:next" plain dimColor onPress={() => actions.page(page + 1)}>
                下一页 ›
              </Button>
            ) : (
              <Text dimColor>下一页 ›</Text>
            )}
          </Box>
        )}
        {diff.isCut && <Text dimColor>太长了，只显示前面一部分。</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text dimColor>本会话改了 </Text>
        <Text>{`${data.files.length} 个文件`}</Text>
        <Text color="green">{` +${added}`}</Text>
        <Text color="red">{` -${removed}`}</Text>
        {hasTurnFiles && <Text dimColor> · ● 这一轮改过</Text>}
      </Text>
      {shown.map(fileRow)}
      {data.files.length > shown.length && <Text dimColor>{`  …还有 ${data.files.length - shown.length} 个文件`}</Text>}
      {picked ? (
        <Box flexDirection="column" marginTop={1}>
          {diffOf(picked)}
        </Box>
      ) : (
        <Text dimColor>点一个文件看它改了什么。</Text>
      )}
    </Box>
  )
}
