import type { SessionContextBreakdown } from 'claude-code'

import type { HudContextPart, HudContextParts } from '../types'

import { relativePath } from './ledger'

// 上下文里装了什么：把 Claude Code 估出来的 /context 明细整理成几张小表

// /context 每一行的名字换成中文；认不出的照原样
const PART_NAMES: Record<string, string> = {
  'System prompt': '系统提示',
  'System tools': '内置工具说明',
  'MCP tools': 'MCP 工具说明',
  'Custom agents': '自定义 agent',
  'Memory files': '记忆文件',
  Skills: '技能列表',
  'Slash commands': '命令列表',
  Messages: '对话',
}

export const partName = (name: string) => PART_NAMES[name] ?? name

const byTokens = (a: HudContextPart, b: HudContextPart) => b.tokens - a.tokens

// 会话目录下的写相对路径，家目录下的写成 ~/…
const shortPath = (path: string, cwd: string) => {
  const inCwd = relativePath(path, cwd)
  if (inCwd !== path) {
    return inCwd
  }
  const home = cwd.match(/^\/(Users|home)\/[^/]+/)?.[0]

  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

// 占着窗口的才画成横条（kind 是 used）；空着的、压缩预留的不算；按需加载的只记个总数。
// 哪个字段没给都当空的，版本不同时少了某项也不出错
export const partsOf = (b: SessionContextBreakdown, at: number, cwd: string): HudContextParts => {
  const categories = b.categories ?? []
  const servers = new Map<string, number>()
  for (const tool of b.mcpTools ?? []) {
    if (tool.isLoaded) {
      servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + tool.tokens)
    }
  }

  return {
    at,
    parts: categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(c => ({ name: c.name, tokens: c.tokens }))
      .sort(byTokens),
    mcp: [...servers].map(([name, tokens]) => ({ name, tokens })).sort(byTokens),
    memory: (b.memoryFiles ?? []).map(f => ({ name: shortPath(f.path, cwd), tokens: f.tokens })).sort(byTokens),
    deferred: categories.filter(c => c.kind === 'deferred').reduce((n, c) => n + c.tokens, 0),
  }
}
