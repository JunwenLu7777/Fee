import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, RenderElement, TurnUsage, UiCopyResult } from 'claude-code'

import { cellWidth, padEnd } from './format'
import { parseNumstat } from './snapshot'
import { withLastContext } from './ledger'

const BYPASS = '⏵⏵ bypass permissions on (shift+tab to cycle)'
const CWD = '/Users/me/code/engineering-kit'
const HINT = { isDraft: false, isWorking: false, hint: BYPASS }
const NOW = Date.parse('2026-10-02T12:00:00Z')
const GIT_STATUS = [
  '# branch.oid 1234567890abcdef',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -0',
  '1 .M N... 100644 100644 100644 aaa bbb hooks/register.tsx',
  '? notes.md',
  '',
].join('\n')
const USAGE: TurnUsage = {
  model: 'claude-opus-5-5',
  input_tokens: 1000,
  output_tokens: 2500,
  cache_read_input_tokens: 9000,
  cache_creation_input_tokens: 0,
}

// /api/oauth/usage 的答复：按模型分的周额度在 limits[] 里
const usageBody = (percent: number) =>
  JSON.stringify({
    five_hour: { utilization: 23, resets_at: new Date(NOW + 90 * 60_000).toISOString() },
    seven_day: { utilization: 41, resets_at: new Date(NOW + 3 * 86_400_000).toISOString() },
    limits: [
      {
        kind: 'seven_day',
        group: 'weekly',
        percent,
        resets_at: new Date(NOW + 2 * 86_400_000).toISOString(),
        severity: 'normal',
        is_active: true,
        scope: { model: { display_name: 'Fable' } },
      },
    ],
  })

type World = {
  isEngineHint?: boolean
  agents?: AgentInfo[]
  // 每次 http.fetch 依次答的 body，null 表示请求失败；用完了就一直答最后一个
  usage?: (string | null)[]
  authKind?: 'bearer' | 'api-key' | null
  // 记下每次 http.fetch 的 URL
  fetched?: string[]
  // 记下放进剪贴板的文字和弹出的提示；copyResult 是剪贴板的答复
  copied?: string[]
  toasts?: string[]
  copyResult?: UiCopyResult
  // session.usage 每次答的开始时间和花费；测试改它来模拟 /clear、/resume 换了会话
  session?: { startedAt: number; cost: number }
  // 给了就当是 git 仓库：拍快照得到 tree（测试改它来模拟工作区变了），
  // 两棵树的对比按「从..到」查 numstat，没有的当没改；不给就当不是 git 仓库
  repo?: Repo
  // ccusage daily --json 答的内容；不给就当没装 ccusage。每次跑都记进 ccusageRuns
  ccusage?: string
  ccusageRuns?: string[][]
  // 自动压缩在上下文到多少 token 时触发；不给就当关着
  compactAt?: number
}

type Repo = { tree: string; numstat: Record<string, string>; snapshots: number }

// 当前测试的时钟拨 0 毫秒：等后台还没跑完的活（比如启动时拉 Fable 额度）都跑完
let settle = async () => {}

const world = (
  on: On,
  stored: Record<string, unknown> = {},
  {
    isEngineHint = false,
    agents = [],
    usage = [usageBody(12)],
    authKind = 'bearer',
    fetched = [],
    copied = [],
    toasts = [],
    copyResult = { isCopied: true },
    session = { startedAt: NOW - 42 * 60_000, cost: 1.23 },
    repo,
    ccusage,
    ccusageRuns = [],
    compactAt,
  }: World = {},
) => {
  const clock = mock.clock(on, { now: NOW })
  settle = () => clock.settle()
  on('session.authorize', () => ({ value: authKind ? { handle: 'cred-1', kind: authKind } : null }))
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    const body = usage[Math.min(fetched.length - 1, usage.length - 1)] ?? null

    return {
      value:
        body === null
          ? { status: 503, ok: false, headers: {}, text: '' }
          : { status: 200, ok: true, headers: {}, text: body },
    }
  })
  // $.store 就是 stored 这个对象，测试改它来模拟别的会话存了东西
  on('store.get', ($, e) => ({ value: stored[e.key] }))
  on('store.set', ($, e) => {
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: CWD }))
  on('settings.read', () => ({ value: { effortLevel: 'xhigh' } }))
  on('session.usage', ($, e) => ({
    value: {
      startedAt: session.startedAt,
      context: {
        tokens: 68_000,
        window: 200_000,
        percent: 34,
        // 要了分类明细才带上自动压缩的点；测试只用得到这两项
        ...(e.breakdown && compactAt ? { breakdown: { autoCompactThreshold: compactAt, isAutoCompactEnabled: true } as never } : {}),
      },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: new Date(NOW + 90 * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
      ],
      cost: { usd: session.cost },
    },
  }))
  on('session.turns', () => ({ value: 12 }))
  on('session.version', () => ({ value: { version: '2.1.287', base: '2.1.287' } }))
  on('process.run', ($, e) => {
    const answer = (exitCode: number, stdout: string) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'date') {
      return answer(0, '+0800\n')
    }
    if (e.argv.includes('ccusage')) {
      ccusageRuns.push([...e.argv])

      return ccusage === undefined
        ? { value: { ...answer(127, '').value, stderr: 'nice: ccusage: No such file or directory' } }
        : answer(0, ccusage)
    }
    // 给工作区拍快照
    if (e.argv[0] === 'sh') {
      if (!repo) {
        return answer(1, '')
      }
      repo.snapshots += 1

      return answer(0, `${CWD}\n${repo.tree}\n\n`)
    }
    if (e.argv[1] === 'diff') {
      const [from, to] = e.argv.slice(-2)

      return answer(0, repo?.numstat[`${from}..${to}`] ?? '')
    }

    return answer(0, GIT_STATUS)
  })
  on('agent.list', () => ({ value: agents }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer, ...(e.usage ? { usage: e.usage } : {}) }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('tool.call', { tool: 'Edit' }, () => ({
    result: {
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] }],
    },
  }))
  on('tool.call', { tool: 'Write' }, ($, e) => ({
    result: { type: 'create', content: String(e.content), structuredPatch: [], originalFile: null },
  }))
  on('tool.call', { tool: 'TodoWrite' }, ($, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))
  // false 开头的命令当作退出码不为 0
  on('tool.call', { tool: 'Bash' }, ($, e) =>
    String(e.command).startsWith('false')
      ? { isError: true as const, result: 'Exit code 1' }
      : { result: { stdout: 'ok', stderr: '', interrupted: false, isImage: false } },
  )
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'a1' }))
  // 代替引擎画每轮结尾那行；isEngineHint 时答引擎节点
  on('ui.render', { component: 'TurnDuration' }, ($, e) => {
    if (isEngineHint) {
      return { type: 'engine', ref: 0 } as const
    }
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>{`✻ ${e.props.word} for ${e.props.durationMs}ms`}</Text>
  })
  // 代替引擎画原来那行提示；isEngineHint 时答引擎节点，和真实会话里 next(e) 拿到的一样
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    if (isEngineHint) {
      return { type: 'engine', ref: 0 } as const
    }
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>{e.props.hint}</Text>
  })
  // 代替引擎画一段回复，和真实会话里 next(e) 拿到的一样是引擎节点
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }) as const)
  on('ui.copy', ($, e) => {
    copied.push(e.text)

    return { value: copyResult }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return clock
}

const hud = ($: Engine, args: string) =>
  $.command.run({
    command: 'hud',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

// 启动后 HUD 在后台拉 Fable 额度，等它回来再看画面，不然要看谁跑得快
const start = async ($: Engine) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
}

const mount = ($: Engine, columns = 200, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({
    plugin: 'hud',
    surface,
    component: 'PromptHint',
    props: HINT,
    viewport: { columns, rows: 50, isFullscreen: true },
  })

const textOf = (node: RenderElement | string): string =>
  typeof node === 'string'
    ? node
    : 'children' in node && Array.isArray(node.children)
      ? node.children.map(c => textOf(c as RenderElement | string)).join('')
      : ''

// 每一行的文字：宽窗口 [原来的提示, 模型、限额和花费, 工作区]，窄窗口 [原来的提示, 模型和限额, token 和花费, 工作区]
const rowsOf = async ($: Engine, columns = 200, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await mount($, columns, surface)
  const root = await ui.drawn()
  await ui.unmount()

  return 'children' in root && Array.isArray(root.children)
    ? root.children.map(c => textOf(c as RenderElement))
    : []
}

const complete = ($: Engine, turnId: string, { agentId, answer = '' }: { agentId?: string; answer?: string } = {}) =>
  $.turn.complete({
    turnId,
    answer,
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
    usage: USAGE,
    ...(agentId ? { agentId } : {}),
  })

const RESOURCES = '◆ Opus 5.5 · xhigh │ ctx ▰▰▰▱▱▱▱▱▱▱ 34% 68k/200k │ 5h ▰▱▱▱▱ 23% ↻1h30m · 7d ▰▰▱▱▱ 41% · fable ▰▱▱▱▱ 12%'
// 第几轮、时间、版本紧跟在分支后面，不被推到屏幕最右边；NOW 是 UTC 12:00，date +%z 答 +0800
const WORKSPACE = 'engineering-kit ⎇ main ±1 ?1 ↑1 │ #12 │ 20:00 │ v2.1.287'

test('原来的提示在最上面，宽窗口 HUD 两行：模型、限额和花费一行，工作区一行', async ($, on) => {
  world(on)
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    // 周限额没到 70% 不显示倒计时
    expect(await rowsOf($, 200, surface)).toEqual([BYPASS, `${RESOURCES} │ cost $1.23 · session 42m`, WORKSPACE])
  }
})

test('窗口窄于 150 列时拆成三行：token 和花费单独一行', async ($, on) => {
  world(on)
  await start($)

  expect((await rowsOf($, 150)).length).toBe(3)
  expect(await rowsOf($, 149)).toEqual([BYPASS, RESOURCES, 'cost $1.23 · session 42m', WORKSPACE])
})

test('两行放不下时先让掉本轮花费和 in/out，仍是两行', async ($, on) => {
  world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.session.measure({
    context: { tokens: 720_000, window: 1_000_000, percent: 72 },
    // 照这个用法都撑得到重置，不带预测
    rateLimits: [
      { kind: 'five_hour', percentUsed: 63, resetsAt: new Date(NOW + 45 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 81, resetsAt: new Date(NOW + 86_400_000).toISOString() },
    ],
    cost: { usd: 1.5 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  await complete($, 't1')

  const head = '◆ Opus 5.5 1M · xhigh │ ctx ▰▰▰▰▰▰▰▱▱▱ 72% 720k/1M │ 5h ▰▰▰▱▱ 63% ↻45m · 7d ▰▰▰▰▱ 81% ↻1d · fable ▰▱▱▱▱ 12%'
  expect((await rowsOf($, 200))[1]).toBe(`${head} │ in 10k · out 2.5k · cache 90% │ cost $1.50 (上轮 +0.27) · session 42m`)
  const narrower = await rowsOf($, 160)
  expect(narrower.length).toBe(3)
  expect(narrower[1]).toBe(`${head} │ cache 90% │ cost $1.50 · session 42m`)
})

test('进度条一格都填不满时不画，只留百分比', async ($, on) => {
  world(on, {}, { usage: [usageBody(0)] })
  await start($)
  await $.session.measure({
    context: { tokens: 30_000, window: 1_000_000, percent: 3 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 5, resetsAt: new Date(NOW + 108 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 1, resetsAt: new Date(NOW + 5 * 86_400_000).toISOString() },
    ],
    cost: { usd: 0 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  expect((await rowsOf($))[1]).toBe(
    '◆ Opus 5.5 1M · xhigh │ ctx 3% 30k/1M │ 5h 5% ↻1h48m · 7d 1% · fable 0% │ cost $0.00 · session 42m',
  )
})

test('引擎自己那行提示作为子节点时，整棵树仍能通过校验', async ($, on) => {
  world(on, {}, { isEngineHint: true })
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, 200, surface)
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    await ui.unmount()
  }
})

test('终端变窄时每行按优先级精简，而不是从中间截断', async ($, on) => {
  world(on)
  await start($)

  const [, resources] = await rowsOf($, 70)
  expect(resources).toContain('Opus 5.5')
  expect(resources).toContain('34%')
  expect(resources).not.toContain('68k/200k')
  expect(resources).not.toContain('↻')
  expect(resources).not.toContain('5h ▰')

  const [, , , workspace] = await rowsOf($, 30)
  expect(workspace).toContain('⎇ main')
  expect(workspace).not.toContain('engineering-kit')
})

test('上下文和限额随 session.measure 更新', async ($, on) => {
  world(on)
  await start($)
  await $.session.measure({
    context: { tokens: 170_000, window: 200_000, percent: 85 },
    rateLimits: [],
    cost: { usd: 4.5 },
    changed: ['context', 'cost'],
  })

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /85%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$4\.50/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5h/ })).toBeUndefined()
})

test('本轮计时每秒走动，turn.step 带来实际 effort', async ($, on) => {
  const clock = world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'max', messageCount: 1 })) {
    // 读完这一步的流
  }
  await clock.advance(3000)

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /^3s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· max/ })).toBeDefined()
})

test('token 和缓存命中率累计，本轮花费跟在总花费后面', async ($, on) => {
  world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.session.measure({
    context: { tokens: 80_000, window: 200_000, percent: 40 },
    rateLimits: [],
    cost: { usd: 1.5 },
    changed: ['context', 'cost'],
  })
  await complete($, 't1')

  const [, resources] = await rowsOf($)
  expect(resources).toContain('in 10k · out 2.5k · cache 90% │ cost $1.50 (上轮 +0.27) · session 42m')
})

test('子 agent 跑完不会把主对话的本轮当成结束', async ($, on) => {
  world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($, 's1', { agentId: 'agent-1' })

  let [, , workspace] = await rowsOf($)
  expect(workspace).not.toContain('上轮')
  // 子 agent 的 token 也算进会话总量
  expect((await rowsOf($))[1]).toContain('out 2.5k')

  await complete($, 't1')
  ;[, , workspace] = await rowsOf($)
  expect(workspace).toContain('上轮')
  expect((await rowsOf($))[1]).toContain('out 5k')
})

test('Edit / Write 累计改动行数', async ($, on) => {
  world(on)
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'b', new_string: 'c\nd' })
  expect((await rowsOf($))[2]).toContain('+2 -1')

  await $.tool.call({ tool: 'Write', file_path: '/repo/b.ts', content: 'x\ny\nz\n' })
  expect((await rowsOf($))[2]).toContain('+5 -1')

  // 新建空文件不算一行
  await $.tool.call({ tool: 'Write', file_path: '/repo/empty.ts', content: '' })
  expect((await rowsOf($))[2]).toContain('+5 -1')
})

for (const command of ['clear', 'resume'] as const) {
  test(`/${command} 之后换成新会话的数：时长重新算，token、改动行数、待办和上一轮清掉`, async ($, on) => {
    const session = { startedAt: NOW - 42 * 60_000, cost: 1.23 }
    world(on, {}, { session })
    // 代替引擎跑 /clear、/resume
    on('command.run', { command }, () => ({ text: '' }))
    await start($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'b', new_string: 'c\nd' })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [{ content: '写测试', status: 'in_progress', activeForm: '正在写测试' }],
    })
    await complete($, 't1')
    let [, resources, workspace] = await rowsOf($)
    expect(resources).toContain('in 10k · out 2.5k · cache 90% │ cost $1.23 · session 42m')
    expect(workspace).toContain('+2 -1 │ ✓ 0/1 正在写测试')
    expect(workspace).toContain('上轮')

    Object.assign(session, { startedAt: NOW - 60_000, cost: 0 })
    await $.command.run({
      command,
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })
    ;[, resources, workspace] = await rowsOf($)
    expect(resources).toContain('fable ▰▱▱▱▱ 12% │ cost $0.00 · session 1m')
    expect(resources).not.toContain('in 10k')
    expect(workspace).not.toContain('+2 -1')
    expect(workspace).not.toContain('✓')
    expect(workspace).not.toContain('上轮')
  })
}

test('额度过了重置时间还没有新读数时按 0% 画，不再挂着旧的百分比', async ($, on) => {
  const clock = world(on)
  await start($)
  await $.session.measure({
    context: { tokens: 68_000, window: 200_000, percent: 34 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(NOW + 30 * 60_000).toISOString() }],
    cost: { usd: 1.23 },
    changed: ['rateLimits'],
  })
  expect((await rowsOf($))[1]).toContain('5h ▰▰▰▰▰ 95% ↻30m')

  await clock.advance(31 * 60_000)
  const [, resources] = await rowsOf($)
  expect(resources).toContain('5h 0% · fable')
  expect(resources).not.toContain('95%')
})

// 画出来的某一小段字是什么颜色
const colorOf = async (ui: { drawn: () => Promise<RenderElement> }, text: string) =>
  nodesOf(await ui.drawn()).find(n => n.children?.length === 1 && n.children[0] === text)?.props?.color

// 只有 5 小时额度的读数：用了 percent，还有 minutes 分钟重置
const fiveHour = (percent: number, minutes: number) => ({
  context: { tokens: 68_000, window: 200_000, percent: 34 },
  rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: new Date(NOW + minutes * 60_000).toISOString() }],
  cost: { usd: 1.23 },
  changed: ['rateLimits' as const],
})

test('照这个窗口到现在的速度重置前就会用完时，额度后面写约几点用完，变黄，并弹一次提示', async ($, on) => {
  const toasts: string[] = []
  world(on, {}, { toasts })
  await start($)
  expect(toasts).toEqual([])

  // 开始 2h15m 用了 63%，照这个速度 1h19m 后（本地 21:19）用完，22:45 才重置
  await $.session.measure(fiveHour(63, 165))
  expect((await rowsOf($))[1]).toContain('5h ▰▰▰▱▱ 63% ↻2h45m 约21:19用完 · fable')
  expect(toasts).toEqual(['照现在的速度，5 小时额度约 21:19 用完（1h19m后），22:45 才重置'])
  const ui = await mount($)
  expect(await colorOf(ui, ' 约21:19用完')).toBe('yellow')
  expect(await colorOf(ui, '63%')).toBe('yellow')
  await ui.unmount()

  // 同一个窗口里再有新读数也不再弹
  await $.session.measure(fiveHour(66, 160))
  expect(toasts).toHaveLength(1)
})

test('离用完不到半小时标红；窗口刚开始半小时内不预测', async ($, on) => {
  const toasts: string[] = []
  world(on, {}, { toasts })
  await start($)

  // 开始 20 分钟就用了 40%，太早，先不预测
  await $.session.measure(fiveHour(40, 280))
  expect((await rowsOf($))[1]).not.toContain('用完')
  expect(toasts).toEqual([])

  // 开始 1 小时用了 75%：20 分钟后就用完，百分比虽然没到 80% 也标红
  await $.session.measure(fiveHour(75, 240))
  expect((await rowsOf($))[1]).toContain('5h ▰▰▰▰▱ 75% ↻4h 约20:20用完')
  const ui = await mount($)
  expect(await colorOf(ui, ' 约20:20用完')).toBe('red')
  expect(await colorOf(ui, '75%')).toBe('red')
  await ui.unmount()
  expect(toasts).toEqual(['照现在的速度，5 小时额度约 20:20 用完（20m后），周六 00:00 才重置'])
})

test('接近 1M 的 token 数显示成 1M，不是 1000k', async ($, on) => {
  world(on)
  await start($)
  await $.session.measure({
    context: { tokens: 999_999, window: 1_000_000, percent: 99 },
    rateLimits: [],
    cost: { usd: 1.23 },
    changed: ['context'],
  })

  const [, resources] = await rowsOf($)
  expect(resources).toContain('99% 1M/1M')
  expect(resources).not.toContain('1000k')
})

test('TodoWrite 显示完成进度和正在做的事', async ($, on) => {
  world(on)
  await start($)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: '读代码', status: 'completed', activeForm: '正在读代码' },
      { content: '写测试', status: 'in_progress', activeForm: '正在写测试' },
      { content: '跑测试', status: 'pending', activeForm: '正在跑测试' },
    ],
  })

  expect((await rowsOf($))[2]).toContain('✓ 1/3 正在写测试')
})

test('有子 agent 在跑时显示数量', async ($, on) => {
  const running = (id: string): AgentInfo => ({ id, description: id, type: 'Explore', status: 'running' })
  world(on, {}, {
    agents: [running('a1'), running('a2'), { id: 'a3', description: 'a3', type: 'Explore', status: 'completed' }],
  })
  await start($)

  expect((await rowsOf($))[2]).toContain('◇ 2 agents')
})

test('Fable 周额度从 /api/oauth/usage 拿，快用完时带倒计时，隔一阵才再拉', async ($, on) => {
  const fetched: string[] = []
  const clock = world(on, {}, { usage: [usageBody(12), usageBody(75)], fetched })
  await start($)
  expect((await rowsOf($))[1]).toContain('fable ▰▱▱▱▱ 12%')
  expect(fetched).toEqual(['https://api.anthropic.com/api/oauth/usage'])

  // 两分钟内的 turn.complete 不再请求
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($, 't1')
  expect(fetched.length).toBe(1)

  await clock.advance(300_000)
  expect(fetched.length).toBe(2)
  expect((await rowsOf($))[1]).toContain('fable ▰▰▰▰▱ 75% ↻1d23h')
})

test('拉额度失败时保留上一次的数', async ($, on) => {
  const fetched: string[] = []
  const clock = world(on, {}, { usage: [usageBody(30), null], fetched })
  await start($)
  await clock.advance(300_000)
  expect(fetched.length).toBe(2)
  expect((await rowsOf($))[1]).toContain('fable ▰▰▱▱▱ 30%')
})

test('API key 登录没有订阅额度，不去请求', async ($, on) => {
  const fetched: string[] = []
  world(on, {}, { authKind: 'api-key', fetched })
  await start($)
  expect((await rowsOf($))[1]).not.toContain('fable')
  expect(fetched).toEqual([])
})

test('答复里没有 Fable 那条就不显示', async ($, on) => {
  world(on, {}, { usage: [JSON.stringify({ limits: [] })] })
  await start($)
  expect((await rowsOf($))[1]).not.toContain('fable')
})

test('工作区那行后段：第几轮、上轮耗时、本地时间、版本，时间按分钟走', async ($, on) => {
  const clock = world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(2000)
  await complete($, 't1')
  expect((await rowsOf($))[2]).toContain('#12 │ 上轮 2s ⚒0 │ 20:00 │ v2.1.287')

  await clock.advance(58_000)
  expect((await rowsOf($))[2]).toContain('20:01')
})

const isDrawn = async ($: Engine) => {
  const ui = await mount($)
  const found = await ui.find({ type: 'Text', text: /Opus 5\.5/ })
  const hint = await ui.find({ type: 'Text', text: BYPASS })
  await ui.unmount()
  expect(hint).toBeDefined()

  return found !== undefined
}

test('/hud 切换开关，关掉后原来的提示行照常显示', async ($, on) => {
  world(on)
  await start($)
  expect(await isDrawn($)).toBe(true)

  expect((await hud($, '')).text).toContain('已关闭')
  expect(await isDrawn($)).toBe(false)

  expect((await hud($, '')).text).toContain('已打开')
  expect(await isDrawn($)).toBe(true)

  await hud($, 'off')
  await hud($, 'off')
  expect(await isDrawn($)).toBe(false)

  await hud($, 'on')
  expect(await isDrawn($)).toBe(true)

  expect((await hud($, 'what')).text).toContain('用法')
  expect(await isDrawn($)).toBe(true)
})

test('关掉后下次启动仍保持关闭', async ($, on) => {
  world(on, { isHidden: true })
  await start($)
  expect(await isDrawn($)).toBe(false)
})

const mountReply = (
  $: Engine,
  text: string,
  { isFullscreen = true, isSummary = false }: { isFullscreen?: boolean; isSummary?: boolean } = {},
) =>
  $.ui.mount({
    plugin: 'hud',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true, ...(isSummary ? { isSummary: true as const } : {}) },
    viewport: { columns: 200, rows: 50, isFullscreen },
  })

// 画出来的树里的每个节点；悬停样式挂在元素上，不在 props 里
type Drawn = { props?: Record<string, unknown>; hover?: unknown; children?: unknown[] }
const nodesOf = (node: unknown): Drawn[] => {
  const n = (node ?? {}) as Drawn

  return [n, ...(Array.isArray(n.children) ? n.children.flatMap(nodesOf) : [])]
}

const hasCopy = async ($: Engine, text: string, options?: { isFullscreen?: boolean; isSummary?: boolean }) => {
  const ui = await mountReply($, text, options)
  const found = await ui.find({ type: 'Button', key: 'copy' })
  await ui.unmount()

  return found !== undefined
}

test('每轮最后那段回复下面有 copy，点了复制这段，按钮一会儿变成 ✓ copied 再变回来', async ($, on) => {
  const copied: string[] = []
  const toasts: string[] = []
  const clock = world(on, {}, { copied, toasts })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($, 't1', { answer: '## 结论\n\n能做。\n' })

  const ui = await mountReply($, '## 结论\n\n能做。')
  // 平时不变色；只有指到 copy 那一小块时，前面定宽的格子里才冒出 ❯
  const button = await ui.find({ type: 'Button', key: 'copy' })
  expect(button?.text).toBe('copy')
  expect(button?.props.hover).toBeUndefined()
  const hidden = nodesOf(await ui.drawn()).filter(n => n.props?.display === 'none')
  expect(hidden.map(n => [n.hover, textOf(n as RenderElement)])).toEqual([[{ display: 'flex' }, '❯']])
  // 点击要等 ✓ copied 换回来才算完，先不等它，拨着时钟看中间的样子
  const pressing = ui.press({ key: 'copy' })
  await clock.advance(1000)
  expect(copied).toEqual(['## 结论\n\n能做。'])
  expect(toasts).toEqual([])
  expect(await ui.find({ type: 'Text', text: '✓ copied' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'copy' })).toBeUndefined()

  await clock.advance(500)
  await pressing
  expect(await ui.find({ type: 'Text', text: '✓ copied' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'copy' })).toBeDefined()
})

test('回复先画出来，这轮结束时按钮跟着出现', async ($, on) => {
  world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await mountReply($, '最终答案')
  expect(await ui.find({ type: 'Button', key: 'copy' })).toBeUndefined()

  await complete($, 't1', { answer: '最终答案' })
  expect(await ui.find({ type: 'Button', key: 'copy' })).toBeDefined()
})

test('中间的进度说明、子 agent 的报告、主屏模式和折叠的摘要都不带复制按钮', async ($, on) => {
  world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($, 's1', { agentId: 'agent-1', answer: '子 agent 的报告' })
  await complete($, 't1', { answer: '最终答案' })

  expect(await hasCopy($, '最终答案')).toBe(true)
  expect(await hasCopy($, '正在看代码')).toBe(false)
  expect(await hasCopy($, '子 agent 的报告')).toBe(false)
  expect(await hasCopy($, '最终答案', { isFullscreen: false })).toBe(false)
  expect(await hasCopy($, '最终答案', { isSummary: true })).toBe(false)
})

test('剪贴板写不进去时提示原因', async ($, on) => {
  const toasts: string[] = []
  world(on, {}, { toasts, copyResult: { isCopied: false, reason: 'no-clipboard' } })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($, 't1', { answer: '最终答案' })

  const ui = await mountReply($, '最终答案')
  await ui.press({ key: 'copy' })
  expect(toasts).toEqual(['复制失败：no-clipboard'])
  expect(await ui.find({ type: 'Text', text: '✓ copied' })).toBeUndefined()
})

// ---------- 每轮小票和明细面板 ----------

const mountFooter = ($: Engine, durationMs: number) =>
  $.ui.mount({
    plugin: 'hud',
    surface: 'terminal',
    component: 'TurnDuration',
    props: { word: 'Baked', durationMs },
    viewport: { columns: 200, rows: 50, isFullscreen: true },
  })

const footerOf = async ($: Engine, durationMs: number) => {
  const ui = await mountFooter($, durationMs)
  const lines = screenOf(await ui.drawn())
  await ui.unmount()

  return lines
}

// 画出来的树排成屏幕上的行：列方向往下排，行方向并排（每个孩子按它最宽的那行补齐）；按钮的字也算上
const screenOf = (node: unknown): string[] => {
  if (typeof node === 'string') {
    return [node]
  }
  type Props = { label?: unknown; flexDirection?: unknown; columnGap?: unknown; paddingLeft?: unknown; marginRight?: unknown }
  const n = (node ?? {}) as { type?: string; props?: Props; children?: unknown[] }
  if (n.type === 'Button') {
    return [String(n.props?.label ?? '')]
  }
  if (n.type === 'Text') {
    return [textOf(n as RenderElement)]
  }
  const kids = (Array.isArray(n.children) ? n.children : []).map(screenOf).filter(k => k.length > 0)
  const left = ' '.repeat(Number(n.props?.paddingLeft ?? 0))
  const right = ' '.repeat(Number(n.props?.marginRight ?? 0))
  if (n.type !== 'Box' || n.props?.flexDirection === 'column') {
    return kids.flat().map(l => left + l + right)
  }
  const widths = kids.map(k => Math.max(0, ...k.map(cellWidth)))
  const height = Math.max(0, ...kids.map(k => k.length))
  const gap = ' '.repeat(Number(n.props?.columnGap ?? 0))

  return Array.from({ length: height }, (_, r) =>
    (
      left +
      kids
        .map((k, i) => padEnd(k[r] ?? '', widths[i] ?? 0))
        .join(gap) +
      right
    ).trimEnd(),
  )
}

const hudText = async (ui: { drawn: () => Promise<RenderElement> }) => screenOf(await ui.drawn()).join('\n')

// 画出 HUD，点第一行前面的 ▸ 展开明细
const expand = async ($: Engine, columns = 200) => {
  const ui = await mount($, columns)
  await ui.press({ key: 'hud:details' })

  return ui
}

// 一轮：改一个文件，跑两条命令（一条失败），花费从 1.23 涨到 1.50
const oneTurn = async ($: Engine) => {
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'b', new_string: 'c\nd' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'false && echo never' })
  await $.session.measure({
    context: { tokens: 80_000, window: 200_000, percent: 40 },
    rateLimits: [],
    cost: { usd: 1.5 },
    changed: ['context', 'cost'],
  })
  await complete($, 't1')
}

test('每轮结尾那行下面另起一行写小票：花费、改了哪些文件、几条命令失败；对不上的轮次原样画', async ($, on) => {
  world(on)
  await start($)
  await oneTurn($)

  expect(await footerOf($, 1000)).toEqual(['✻ Baked for 1000ms', '  ⎿  $0.27 · 改 a.ts +2 -1 · 2 条命令，1 条失败'])
  expect(await footerOf($, 60_000)).toEqual(['✻ Baked for 60000ms'])
})

test('每轮结尾那行是引擎自己画的节点时，接上小票的整行仍能通过校验', async ($, on) => {
  world(on, {}, { isEngineHint: true })
  await start($)
  await oneTurn($)

  const ui = await mountFooter($, 1000)
  expect(await ui.drawn()).toMatchObject({ type: 'Box' })
  expect(await ui.find({ type: 'Text', text: '1 条失败' })).toBeDefined()
  await ui.unmount()
})

// 一轮里起一个子 agent，跑完它
const turnWithAgent = async ($: Engine) => {
  await $.turn.start({ text: 'hi', turnId: 't0' })
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: '找出 diff 相关的代码',
    description: '找 diff 代码',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  await complete($, 's1', { agentId: 'a1' })
  await complete($, 't0')
}

test('点 HUD 前面的 ▸ 在下方展开明细，变成 ▾，再点收起；宽窗口三块并排', async ($, on) => {
  world(on)
  await start($)
  await turnWithAgent($)
  await oneTurn($)

  const ui = await mount($, 200)
  expect(await ui.find({ type: 'Button', key: 'hud:details' })).toMatchObject({ text: '▸' })
  expect(await hudText(ui)).not.toContain('工具耗时')

  await ui.press({ key: 'hud:details' })
  expect(await ui.find({ type: 'Button', key: 'hud:details' })).toMatchObject({ text: '▾' })
  const text = await hudText(ui)
  // 轮次：最近的一轮在最上面，默认选中它，下面是它的明细
  expect(text).toContain('本会话 $1.50 · 2 轮 · in 30k · out 7.5k · 缓存 90%')
  // 只有两轮，不画趋势；每轮后面一根横条，花得最多的那轮最长
  expect(text).not.toContain('趋势')
  expect(text).toMatch(/❯ #12\s+1s\s+\$0\.27 █{7}\s+10k\s+2\.5k\s+\+12k\s+1\s+2 ✗1/)
  expect(text).toContain('#12 · 1s · $0.27')
  expect(text).toMatch(/src\/a\.ts\s+\+2 -1/)
  expect(text).toContain('跑了 2 条命令，1 条失败')
  expect(text).toContain('✗ false && echo never')
  // 工具耗时
  expect(text).toContain('调用 3 次 · 共 0ms · 失败 1 次')
  expect(text).toMatch(/Bash\s+0ms\s+2\s+0ms\s+0ms\s+1/)
  // 子 agent
  expect(text).toContain('✓ Explore · 找 diff 代码')
  expect(text).toContain('用时 0s · 工具 0 次 · in 10k · out 2.5k · 第 12 轮')

  await ui.press({ key: 'hud:details' })
  expect(await hudText(ui)).not.toContain('工具耗时')
})

test('跑满 5 轮才画每轮花费的趋势', async ($, on) => {
  world(on)
  await start($)
  for (const id of ['a', 'b', 'c', 'd']) {
    await $.turn.start({ text: 'hi', turnId: id })
    await complete($, id)
  }
  const ui = await expand($)
  expect(await hudText(ui)).not.toContain('趋势')

  await $.turn.start({ text: 'hi', turnId: 'e' })
  await complete($, 'e')
  expect(await hudText(ui)).toContain('趋势 ▁▁▁▁▁ 最近 5 轮花费，最高 $0.00')
})

test('窄窗口展开后点标签切换：轮次、工具耗时、子 agent', async ($, on) => {
  world(on)
  await start($)
  await turnWithAgent($)
  await oneTurn($)

  const ui = await expand($, 120)
  let text = await hudText(ui)
  expect(text).toContain('▸ 轮次')
  expect(text).toContain('#12 · 1s · $0.27')
  expect(text).not.toContain('调用 3 次')

  await ui.press({ key: 'tab:tools' })
  text = await hudText(ui)
  expect(text).toContain('▸ 工具耗时')
  expect(text).toContain('调用 3 次 · 共 0ms · 失败 1 次')

  await ui.press({ key: 'tab:agents' })
  text = await hudText(ui)
  expect(text).toContain('✓ Explore · 找 diff 代码')
})

test('工具耗时按工具分别记：次数、平均、最长', async ($, on) => {
  const clock = world(on)
  // 测试自己的钩子靠测试时钟等，不走 $.clock
  on('tool.call', { tool: 'Read' }, async () => {
    await clock.sleep(1500)

    return { result: { type: 'text', file: { filePath: '/x', content: '', numLines: 0, startLine: 1, totalLines: 0 } } }
  })
  await start($)
  // 调用要等 sleep 走完才回来，先不等它，拨着时钟让它跑完
  const pending = $.tool.call({ tool: 'Read', file_path: '/x' })
  await clock.advance(1500)
  await pending
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const text = await hudText(await expand($))
  expect(text).toContain('调用 2 次 · 共 1.5s')
  expect(text).toMatch(/Read\s+█{8}\s+1\.5s\s+1\s+1\.5s\s+1\.5s\s+-/)
})

test('/clear 之后明细也清空', async ($, on) => {
  world(on)
  on('command.run', { command: 'clear' }, () => ({ text: '' }))
  await start($)
  await oneTurn($)
  await $.command.run({
    command: 'clear',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  const text = await hudText(await expand($))
  expect(text).toContain('还没有跑完的轮次')
  expect(text).toContain('还没有工具调用')
  expect(text).toContain('这次会话还没有子 agent')
})

// ---------- git 快照对比改动行数 ----------

const TREE_A = 'a'.repeat(40)
const TREE_B = 'b'.repeat(40)
const TREE_C = 'c'.repeat(40)

test('git 仓库里小票按这一轮前后两张快照比：Bash 生成的文件也算，同一处改两次只算最后的结果', async ($, on) => {
  const repo: Repo = { tree: TREE_A, numstat: {}, snapshots: 0 }
  world(on, {}, { repo })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  // Edit 每次自己报 +2 -1，两次加起来是 +4 -2；实际同一处改了两次，净改 +2 -1
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'b', new_string: 'c\nd' })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'c\nd', new_string: 'e\nf' })
  repo.tree = TREE_B
  repo.numstat[`${TREE_A}..${TREE_B}`] = '2\t1\tsrc/a.ts\0' + '3\t0\tscripts/gen.sh\0'
  await $.tool.call({ tool: 'Bash', command: 'sh make-gen.sh' })
  await complete($, 't1')

  expect(await footerOf($, 1000)).toEqual(['✻ Baked for 1000ms', '  ⎿  改 a.ts、gen.sh +5 -1 · 1 条命令'])
  // HUD 上的 +N -M 是会话开始以来净改的
  expect((await rowsOf($))[2]).toContain('+5 -1')
})

test('HUD 上的 +N -M 从会话开始算，/clear 之后重新拍一张从头比', async ($, on) => {
  const repo: Repo = { tree: TREE_A, numstat: {}, snapshots: 0 }
  world(on, {}, { repo })
  on('command.run', { command: 'clear' }, () => ({ text: '' }))
  await start($)
  expect(repo.snapshots).toBe(1)

  // 你自己在两轮之间改的也算进会话的改动
  repo.tree = TREE_B
  repo.numstat[`${TREE_A}..${TREE_B}`] = '7\t0\tnotes.md\0'
  await $.turn.start({ text: 'hi', turnId: 't1' })
  repo.tree = TREE_C
  repo.numstat[`${TREE_A}..${TREE_C}`] = '7\t0\tnotes.md\0' + '1\t1\tsrc/a.ts\0'
  repo.numstat[`${TREE_B}..${TREE_C}`] = '1\t1\tsrc/a.ts\0'
  await $.tool.call({ tool: 'Bash', command: "sed -i '' s/b/c/ src/a.ts" })
  await complete($, 't1')
  expect((await rowsOf($))[2]).toContain('+8 -1')
  // 这一轮的小票只算这一轮的
  expect(await footerOf($, 1000)).toEqual(['✻ Baked for 1000ms', '  ⎿  改 a.ts +1 -1 · 1 条命令'])

  await $.command.run({
    command: 'clear',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  await settle()
  expect((await rowsOf($))[2]).not.toContain('+8 -1')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle()
  expect((await rowsOf($))[2]).not.toMatch(/\+\d+ -\d+/)
})

test('numstat 里改了名的、二进制的、会话目录外的文件都认得', async () => {
  const out = '1\t2\thooks/a.ts\0' + '3\t3\t\0hooks/old.ts\0hooks/new.ts\0' + '-\t-\tassets/logo.png\0'
  expect(parseNumstat(out, 'hooks/')).toEqual([
    { path: 'a.ts', added: 1, removed: 2 },
    { path: 'new.ts', added: 3, removed: 3 },
    { path: '../assets/logo.png', added: 0, removed: 0 },
  ])
})

// ---------- 每天花费 ----------

// NOW 是本地 10 月 2 日（周五）20:00
const DAILY = JSON.stringify({
  daily: [
    { date: '2026-09-01', totalCost: 5, totalTokens: 1000 },
    { date: '2026-09-20', totalCost: 10, totalTokens: 1000 },
    { date: '2026-09-30', totalCost: 40, totalTokens: 1000 },
    { date: '2026-10-01', totalCost: 20, totalTokens: 1000 },
    { date: '2026-10-02', totalCost: 80, totalTokens: 1000 },
  ],
  totals: {},
})

const spendTab = async ($: Engine) => {
  const ui = await expand($, 120)
  await ui.press({ key: 'tab:spend' })

  return ui
}

test('每天花费：今天、近 7 天、近 30 天，最近 7 天每天一根横条，今天在最上面', async ($, on) => {
  const ccusageRuns: string[][] = []
  world(on, {}, { ccusage: DAILY, ccusageRuns })
  await start($)
  // 降低优先级跑，只算最近 30 天
  expect(ccusageRuns).toEqual([['nice', '-n', '10', 'ccusage', 'daily', '--json', '--since', '20260903']])

  const text = await hudText(await spendTab($))
  expect(text).toContain('今天 $80.00 · 近 7 天 $140.00 · 近 30 天 $150.00')
  const days = text.split('\n').filter(l => /\d\d\/\d\d 周/.test(l))
  expect(days.map(l => l.replace(/│/g, '').trim().replace(/\s+/g, ' '))).toEqual([
    '10/02 周五 ████████████████████████ $80.00',
    '10/01 周四 ██████ $20.00',
    '09/30 周三 ████████████ $40.00',
    '09/29 周二 -',
    '09/28 周一 -',
    '09/27 周日 -',
    '09/26 周六 -',
  ])
  expect(text).toContain('本机所有会话 · ccusage · 刚刚算的 刷新')
})

test('没装 ccusage 时告诉你怎么装', async ($, on) => {
  world(on)
  await start($)

  expect(await hudText(await spendTab($))).toContain('没找到 ccusage，装上（npm i -g ccusage）就能看每天花了多少。')
})

test('15 分钟内不重复算，展开、跑完一轮都不算；点「刷新」马上重算', async ($, on) => {
  const ccusageRuns: string[][] = []
  const clock = world(on, {}, { ccusage: DAILY, ccusageRuns })
  await start($)
  const ui = await spendTab($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($, 't1')
  expect(ccusageRuns).toHaveLength(1)

  await clock.advance(15 * 60_000)
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await complete($, 't2')
  await settle()
  expect(ccusageRuns).toHaveLength(2)

  await ui.press({ key: 'spend:refresh' })
  expect(ccusageRuns).toHaveLength(3)
})

test('上一次算的存下来，下次启动先画上，没过 15 分钟不重算', async ($, on) => {
  const ccusageRuns: string[][] = []
  const days = [{ date: '2026-10-02', costUsd: 12.5, tokens: 100 }]
  world(on, { daily: { days, fetchedAt: NOW - 5 * 60_000 } }, { ccusage: DAILY, ccusageRuns })
  await start($)
  expect(ccusageRuns).toEqual([])

  const text = await hudText(await spendTab($))
  expect(text).toContain('今天 $12.50')
  expect(text).toContain('ccusage · 5m前算的')
})

test('同时开着别的会话、它刚算过时直接用它存下的，不再跑 ccusage', async ($, on) => {
  const ccusageRuns: string[][] = []
  const stored: Record<string, unknown> = {}
  const clock = world(on, stored, { ccusage: DAILY, ccusageRuns })
  await start($)
  expect(ccusageRuns).toHaveLength(1)

  // 过了 20 分钟，别的会话 2 分钟前刚算过一次存了下来
  await clock.advance(20 * 60_000)
  stored.daily = { days: [{ date: '2026-10-02', costUsd: 99, tokens: 1 }], fetchedAt: NOW + 18 * 60_000 }
  const text = await hudText(await spendTab($))
  expect(ccusageRuns).toHaveLength(1)
  expect(text).toContain('今天 $99.00')
  expect(text).toContain('2m前算的')
})

test('宽窗口最右边一列上面是每天花费、下面是子 agent；额度要提前用完时写在每天花费最上面', async ($, on) => {
  world(on, {}, { ccusage: DAILY })
  await start($)
  await turnWithAgent($)
  await $.session.measure(fiveHour(63, 165))

  const text = await hudText(await expand($, 200))
  expect(text).toContain('每天花费')
  expect(text).toContain('照现在的速度，5 小时额度约 21:19 用完（1h19m后），22:45 才重置')
  expect(text).toContain('今天 $80.00')
  expect(text).toContain('✓ Explore · 找 diff 代码')
  expect(text.indexOf('每天花费')).toBeLessThan(text.indexOf('✓ Explore'))
})

// ---------- 上下文还能撑几轮 ----------

// 跑一轮，跑完时上下文是 tokens
const turnTo = async ($: Engine, id: string, tokens: number) => {
  await $.turn.start({ text: 'hi', turnId: id })
  await $.session.measure({
    context: { tokens, window: 200_000, percent: Math.round(tokens / 2000) },
    rateLimits: [],
    cost: { usd: 1.23 },
    changed: ['context'],
  })
  await complete($, id)
}

test('照最近几轮上下文的涨法，ctx 后面写约几轮后自动压缩；明细里每轮多一列 ctx，能按它排', async ($, on) => {
  world(on, {}, { compactAt: 200_000 })
  await start($)
  // 开始时 68k；只跑了一轮还不估
  await turnTo($, 'a', 100_000)
  expect((await rowsOf($))[1]).not.toContain('压缩')

  // 两轮各涨 +32k、+20k，平均 +26k；离 200k 还差 80k，约 3 轮
  await turnTo($, 'b', 120_000)
  expect((await rowsOf($))[1]).toContain('ctx ▰▰▰▰▰▰▱▱▱▱ 60% 120k/200k 约3轮后压缩')
  const ui = await mount($)
  expect(await colorOf(ui, ' 约3轮后压缩')).toBe('yellow')
  await ui.unmount()

  const details = await expand($, 120)
  let text = await hudText(details)
  expect(text).toContain('上下文 120k · 到 200k 自动压缩 · 每轮约 +26k · 约 3 轮后压缩')
  expect(text).toMatch(/❯ #12 .*\+20k/)
  expect(text).toContain('上下文 +20k')
  await details.press({ key: 'sort-turn:context' })
  text = await hudText(details)
  expect(text).toContain('ctx↓')
  expect(text.indexOf('+32k')).toBeLessThan(text.indexOf('+20k'))
})

test('这一轮里自动压缩过的写「压缩」，估还能撑几轮时不算它', async ($, on) => {
  world(on, {}, { compactAt: 200_000 })
  // 代替引擎压缩：整段对话换成一条摘要
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: '摘要', toolUses: [] }] }))
  await start($)
  await turnTo($, 'a', 100_000)
  await turnTo($, 'b', 120_000)
  await $.turn.start({ text: 'hi', turnId: 'c' })
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
  await $.session.measure({
    context: { tokens: 30_000, window: 200_000, percent: 15 },
    rateLimits: [],
    cost: { usd: 1.23 },
    changed: ['context'],
  })
  await complete($, 'c')

  const text = await hudText(await expand($, 120))
  expect(text).toMatch(/❯ #12 .*压缩/)
  expect(text).toContain('上下文 压缩过')
  // 还是按 +32k、+20k 平均 +26k 算：离 200k 还差 170k，约 6 轮
  expect(text).toContain('上下文 30k · 到 200k 自动压缩 · 每轮约 +26k · 约 6 轮后压缩')
  expect((await rowsOf($))[1]).toContain('15% 30k/200k 约6轮后压缩')
})

test('两轮之间晚到的上下文读数算到上一轮，只往大了改：手动 /compact 变小的不算', async () => {
  const turn = {
    turnId: 't',
    index: 1,
    startedAt: 0,
    durationMs: 1000,
    tools: 0,
    reason: 'answer',
    costAtStart: null,
    receipt: { costUsd: null, tokens: null, model: null, files: [], commands: 0, failed: 0, failedCommands: [], agents: 0 },
    contextAtStart: 50_000,
    contextAtEnd: 60_000,
    isCompacted: false,
  }
  expect(withLastContext([turn], 64_000)[0]?.contextAtEnd).toBe(64_000)
  expect(withLastContext([turn], 20_000)[0]?.contextAtEnd).toBe(60_000)
})

// ---------- /config 里的门槛 ----------

test(
  '/config 里改了门槛：同一条命令失败 2 次就提醒，额度不弹提示（HUD 照写），不写压缩',
  { options: { loopFails: 2, limitAlert: false, compactTurns: 0 } },
  async ($, on) => {
    const toasts: string[] = []
    world(on, {}, { toasts, compactAt: 200_000 })
    await start($)
    await $.session.measure(fiveHour(63, 165))
    expect((await rowsOf($))[1]).toContain('63% ↻2h45m 约21:19用完')
    expect(toasts).toEqual([])

    await turnTo($, 'a', 100_000)
    await turnTo($, 'b', 120_000)
    expect((await rowsOf($))[1]).not.toContain('压缩')

    await $.turn.start({ text: 'hi', turnId: 't' })
    await $.tool.call({ tool: 'Bash', command: 'false x' })
    await $.tool.call({ tool: 'Bash', command: 'false x' })
    expect(toasts).toEqual(['同一条命令连着失败 2 次了，可能在原地打转：false x'])
    await settle()
  },
)

test('/config 里把额度预测的起点调到窗口过一半：过了 45% 还不预测', { options: { forecastAfter: 50 } }, async ($, on) => {
  const toasts: string[] = []
  world(on, {}, { toasts })
  await start($)
  await $.session.measure(fiveHour(63, 165))
  expect((await rowsOf($))[1]).not.toContain('用完')
  expect(toasts).toEqual([])
})

// ---------- 点失败的命令放进输入框 ----------

test('点小票明细里失败的命令，原文放进输入框；已经打了字就另起一行接在后面', async ($, on) => {
  const filled: { text: string; mode: string }[] = []
  const toasts: string[] = []
  let draft = ''
  let isFilled = true
  world(on, {}, { toasts })
  on('prompt.read', () => ({
    value: { text: draft, cursor: draft.length, model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'] },
  }))
  on('prompt.fill', ($, e) => {
    filled.push({ text: e.text, mode: e.mode })

    return isFilled ? { isFilled: true } : { isFilled: false, refusal: 'dialog' as const }
  })
  await start($)
  const command = 'false && npm test -- --grep "很长的名字"\necho 第二行'
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command })
  await complete($, 't1')

  const ui = await expand($, 120)
  const text = await hudText(ui)
  expect(text).toContain('跑了 1 条命令，1 条失败（点一条放进输入框）')
  // 明细里只写第一行
  expect(text).toContain('✗ false && npm test -- --grep "很长的名字"')
  expect(text).not.toContain('echo 第二行')

  await ui.press({ key: 'fail:0' })
  expect(filled).toEqual([{ text: command, mode: 'replace' }])

  draft = '帮我看看'
  await ui.press({ key: 'fail:0' })
  expect(filled[1]).toEqual({ text: `\n${command}`, mode: 'append' })

  // 开着对话框时放不进去，说一声
  isFilled = false
  await ui.press({ key: 'fail:0' })
  expect(toasts).toEqual(['输入框现在放不进去（可能开着别的对话框）'])
})

// ---------- 原地打转提醒 ----------

test('主对话里同一条命令连着失败 3 次弹一次提示；子 agent 的不算，中间跑别的命令不打断', async ($, on) => {
  const toasts: string[] = []
  world(on, {}, { toasts })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const fail = (agentId?: string) => $.tool.call({ tool: 'Bash', command: 'false && npm test', ...(agentId ? { agentId } : {}) })

  await fail()
  await fail()
  // 子 agent 跑同一条命令失败不算进主对话
  await fail('a1')
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'b', new_string: 'c\nd' })
  expect(toasts).toEqual([])
  await fail()
  expect(toasts).toEqual(['同一条命令连着失败 3 次了，可能在原地打转：false && npm test'])
  // 再失败也不重复弹
  await fail()
  expect(toasts).toHaveLength(1)

  // 别的命令成功了不影响它
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await fail()
  expect(toasts).toHaveLength(1)
  // 等工具跑完后台刷新的 git 状态
  await settle()
})

test('同一条命令成功一次后重新数，下一轮也重新数', async ($, on) => {
  const toasts: string[] = []
  world(on, {}, { toasts })
  // 第三次起这条命令成功了
  let runs = 0
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (e.command !== 'flaky') {
      return next(e)
    }
    runs += 1

    return runs === 3 ? { result: { stdout: 'ok', stderr: '', interrupted: false, isImage: false } } : { isError: true as const, result: 'Exit code 1' }
  })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for (let i = 0; i < 4; i += 1) {
    await $.tool.call({ tool: 'Bash', command: 'flaky' })
  }
  // 失败、失败、成功、失败：没有连着三次
  expect(toasts).toEqual([])

  await complete($, 't1')
  await $.turn.start({ text: 'hi', turnId: 't2' })
  for (let i = 0; i < 2; i += 1) {
    await $.tool.call({ tool: 'Bash', command: 'flaky' })
  }
  // 上一轮最后那次失败不带到这一轮
  expect(toasts).toEqual([])
  await settle()
})

test('一轮里同一个文件改到 10 次弹一次提示', async ($, on) => {
  const toasts: string[] = []
  world(on, {}, { toasts })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const edit = () => $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'b', new_string: 'c\nd' })
  for (let i = 0; i < 9; i += 1) {
    await edit()
  }
  expect(toasts).toEqual([])
  await edit()
  expect(toasts).toEqual(['这一轮 src/a.ts 已经改了 10 次，可能在原地打转'])
  await edit()
  expect(toasts).toHaveLength(1)
  await settle()
})

// ---------- 明细里点着看数据 ----------

// 轮次表里每一行的花费，从上到下
const turnCosts = (text: string) => [...text.matchAll(/#12\s+\S+\s+(\$\d+\.\d+)/g)].map(m => m[1])

const measureCost = (usd: number) => ({
  context: { tokens: 80_000, window: 200_000, percent: 40 },
  rateLimits: [],
  cost: { usd },
  changed: ['cost' as const],
})

test('点表头排序：默认最近的在前，点「花费」按花费从高到低', async ($, on) => {
  world(on)
  await start($)
  // 三轮依次花 0.10、0.50、0.20
  let cost = 1.23
  for (const [id, spend] of [
    ['a', 0.1],
    ['b', 0.5],
    ['c', 0.2],
  ] as const) {
    await $.turn.start({ text: 'hi', turnId: id })
    cost += spend
    await $.session.measure(measureCost(cost))
    await complete($, id)
  }

  const ui = await expand($, 120)
  let text = await hudText(ui)
  expect(text).toContain('轮↓')
  expect(turnCosts(text)).toEqual(['$0.20', '$0.50', '$0.10'])

  await ui.press({ key: 'sort-turn:cost' })
  text = await hudText(ui)
  expect(text).toContain('花费↓')
  expect(turnCosts(text)).toEqual(['$0.50', '$0.20', '$0.10'])
})

test('轮次多了翻页看更早的', async ($, on) => {
  world(on)
  await start($)
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    await $.turn.start({ text: 'hi', turnId: id })
    await complete($, id)
  }

  const ui = await expand($, 120)
  let text = await hudText(ui)
  expect(text).toContain('1/2')
  expect(turnCosts(text)).toHaveLength(6)

  await ui.press({ key: 'page:next' })
  text = await hudText(ui)
  expect(text).toContain('2/2')
  expect(turnCosts(text)).toHaveLength(2)
})

test('一轮改的文件多了，点「展开全部」看全，再点收起', async ($, on) => {
  world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/${name}.ts`, old_string: 'b', new_string: 'c\nd' })
  }
  await complete($, 't1')

  const ui = await expand($, 120)
  let text = await hudText(ui)
  expect(text).toContain('src/c.ts')
  expect(text).not.toContain('src/d.ts')
  expect(text).toContain('… 展开全部（还有 2 条）')

  await ui.press({ key: 'turn:more' })
  text = await hudText(ui)
  expect(text).toContain('src/e.ts')
  expect(text).toContain('收起')

  await ui.press({ key: 'turn:less' })
  expect(await hudText(ui)).not.toContain('src/e.ts')
})

test('点工具名看它最慢的几次跑的是什么；点「次数」按次数排', async ($, on) => {
  world(on)
  await start($)
  await oneTurn($)

  const ui = await expand($, 120)
  await ui.press({ key: 'tab:tools' })
  await ui.press({ key: 'tool:Bash' })
  let text = await hudText(ui)
  expect(text).toContain('Bash · 最慢的 2 次')
  expect(text).toMatch(/0ms #12\s+npm test/)
  expect(text).toMatch(/0ms #12\s+✗ false && echo never/)

  // 总耗时一样时保持原来的顺序（Edit 在前）；按次数排 Bash 跑了两次，排到前面
  expect(text.indexOf('Edit')).toBeLessThan(text.indexOf('❯ Bash'))
  await ui.press({ key: 'sort-tool:count' })
  text = await hudText(ui)
  expect(text).toContain('次数↓')
  expect(text.indexOf('❯ Bash')).toBeLessThan(text.indexOf('Edit'))

  // 再点一下收起
  await ui.press({ key: 'tool:Bash' })
  expect(await hudText(ui)).not.toContain('最慢的')
})

test('点子 agent 看它的模型、任务和交回来的报告，再点收起', async ($, on) => {
  world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't0' })
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: '找出 diff 相关的代码',
    description: '找 diff 代码',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  await complete($, 's1', { agentId: 'a1', answer: '找到 2 处：\nregister.tsx 第 10 行\nledger.ts 第 20 行' })
  await complete($, 't0')

  const ui = await expand($, 120)
  await ui.press({ key: 'tab:agents' })
  expect(await hudText(ui)).not.toContain('报告')

  await ui.press({ key: 'agent:a1' })
  const text = await hudText(ui)
  expect(text).toContain('模型 claude-haiku-4-5 · 状态 已完成')
  expect(text).toContain('找出 diff 相关的代码')
  expect(text).toContain('register.tsx 第 10 行')

  await ui.press({ key: 'agent:a1' })
  expect(await hudText(ui)).not.toContain('报告')
})
