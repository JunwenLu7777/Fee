import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, RenderElement, TurnUsage } from 'claude-code'

const BYPASS = '⏵⏵ bypass permissions on (shift+tab to cycle)'
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
}

const world = (
  on: On,
  stored: Record<string, unknown> = {},
  { isEngineHint = false, agents = [], usage = [usageBody(12)], authKind = 'bearer', fetched = [] }: World = {},
) => {
  const clock = mock.clock(on, { now: NOW })
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
  mock.store(on, stored)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/Users/me/code/engineering-kit' }))
  on('settings.read', () => ({ value: { effortLevel: 'xhigh' } }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 42 * 60_000,
      context: { tokens: 68_000, window: 200_000, percent: 34 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: new Date(NOW + 90 * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
      ],
      cost: { usd: 1.23 },
    },
  }))
  on('session.turns', () => ({ value: 12 }))
  on('session.version', () => ({ value: { version: '2.1.287', base: '2.1.287' } }))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'date' ? '+0800\n' : GIT_STATUS,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
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
  // 代替引擎画原来那行提示；isEngineHint 时答引擎节点，和真实会话里 next(e) 拿到的一样
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    if (isEngineHint) {
      return { type: 'engine', ref: 0 } as const
    }
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>{e.props.hint}</Text>
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

const start = ($: Engine) =>
  $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

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

// 每一行的文字：[原来的提示, 模型和限额, token 和花费, 工作区]
const rowsOf = async ($: Engine, columns = 200, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await mount($, columns, surface)
  const root = await ui.drawn()
  await ui.unmount()

  return 'children' in root && Array.isArray(root.children)
    ? root.children.map(c => textOf(c as RenderElement))
    : []
}

const complete = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.complete({
    turnId,
    answer: '',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
    usage: USAGE,
    ...(agentId ? { agentId } : {}),
  })

test('原来的提示在最上面，HUD 分三行：模型和限额、token 和花费、工作区', async ($, on) => {
  world(on)
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const rows = await rowsOf($, 200, surface)
    expect(rows.length).toBe(4)
    expect(rows[0]).toBe(BYPASS)
    for (const text of [
      '◆ Opus 5.5 · xhigh',
      'ctx ▰▰▰▱▱▱▱▱▱▱ 34% 68k/200k',
      '5h ▰▱▱▱▱ 23% ↻1h30m',
      '7d ▰▰▱▱▱ 41%',
      'fable ▰▱▱▱▱ 12%',
    ]) {
      expect(rows[1]).toContain(text)
    }
    // 周限额没到 70% 不显示倒计时
    expect(rows[1]).not.toContain('↻3d')
    expect(rows[2]).toBe('cost $1.23 · session 42m')
    expect(rows[3]).toContain('engineering-kit ⎇ main ±1 ?1 ↑1')
    // NOW 是 UTC 12:00，date +%z 答 +0800
    expect(rows[3]).toContain('#12 │ 20:00 │ v2.1.287')
  }
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

  const [, , spend] = await rowsOf($)
  expect(spend).toContain('in 10k · out 2.5k · cache 90%')
  expect(spend).toContain('cost $1.50 (上轮 +0.27) · session 42m')
})

test('子 agent 跑完不会把主对话的本轮当成结束', async ($, on) => {
  world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($, 's1', 'agent-1')

  let [, , , workspace] = await rowsOf($)
  expect(workspace).not.toContain('上轮')
  // 子 agent 的 token 也算进会话总量
  expect((await rowsOf($))[2]).toContain('out 2.5k')

  await complete($, 't1')
  ;[, , , workspace] = await rowsOf($)
  expect(workspace).toContain('上轮')
  expect((await rowsOf($))[2]).toContain('out 5k')
})

test('Edit / Write 累计改动行数', async ($, on) => {
  world(on)
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'b', new_string: 'c\nd' })
  expect((await rowsOf($))[3]).toContain('+2 -1')

  await $.tool.call({ tool: 'Write', file_path: '/repo/b.ts', content: 'x\ny\nz\n' })
  expect((await rowsOf($))[3]).toContain('+5 -1')
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

  expect((await rowsOf($))[3]).toContain('✓ 1/3 正在写测试')
})

test('有子 agent 在跑时显示数量', async ($, on) => {
  const running = (id: string): AgentInfo => ({ id, description: id, type: 'Explore', status: 'running' })
  world(on, {}, {
    agents: [running('a1'), running('a2'), { id: 'a3', description: 'a3', type: 'Explore', status: 'completed' }],
  })
  await start($)

  expect((await rowsOf($))[3]).toContain('◇ 2 agents')
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

test('第三行右边：第几轮、上轮耗时、本地时间、版本，时间按分钟走', async ($, on) => {
  const clock = world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(2000)
  await complete($, 't1')
  expect((await rowsOf($))[3]).toContain('#12 │ 上轮 2s ⚒0 │ 20:00 │ v2.1.287')

  await clock.advance(58_000)
  expect((await rowsOf($))[3]).toContain('20:01')
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
