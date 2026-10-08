import type { HudFileEdit } from '../types'

// 用 git 给工作区拍快照，前后两张一比就知道这段时间净改了哪些文件、几行：
// Bash、sed、脚本改的也算，同一处改几次只算最后的结果。

// 把所有文件（含没跟踪、没被忽略的）放进一个临时的暂存区，写成一棵树，打印仓库根目录、树的 id、
// 会话目录在仓库里的位置。用临时暂存区，不动你自己的暂存区；临时暂存区从你的复制过来，
// 没改过的文件靠它记着的时间戳直接跳过，所以很快。树和文件内容会作为没人引用的对象写进 .git，git gc 时清掉
export const SNAPSHOT_SCRIPT = [
  'top=$(git rev-parse --show-toplevel) || exit 1',
  'prefix=$(git rev-parse --show-prefix) || exit 1',
  'idx=$(git rev-parse --git-path index) || exit 1',
  'tmp=$(mktemp "${TMPDIR:-/tmp}/claude-hud-index.XXXXXX") || exit 1',
  `trap 'rm -f "$tmp" "$tmp.lock"' EXIT`,
  'cp "$idx" "$tmp" 2>/dev/null || rm -f "$tmp"',
  'GIT_INDEX_FILE="$tmp" git add -A --ignore-errors >/dev/null 2>&1',
  'tree=$(GIT_INDEX_FILE="$tmp" git write-tree) || exit 1',
  `printf '%s\\n%s\\n%s\\n' "$top" "$tree" "$prefix"`,
].join('\n')

export type Snapshot = {
  // 仓库根目录，比两棵树时在这里跑 git
  root: string
  tree: string
  // 会话目录相对仓库根目录的位置，比如 hooks/；就在根目录时为空
  prefix: string
}

export const parseSnapshot = (out: string): Snapshot | null => {
  const [root = '', tree = '', prefix = ''] = out.split('\n')

  return root.startsWith('/') && /^[0-9a-f]{40,64}$/.test(tree) ? { root, tree, prefix } : null
}

// 一轮改的文件太多（比如生成了一堆文件）时只留这么多
const FILES_MAX = 500

// 仓库里的路径改成相对会话目录的：会话目录是 hooks/ 时，hooks/a.ts → a.ts，types/b.ts → ../types/b.ts
const fromPrefix = (path: string, prefix: string) => {
  if (path.startsWith(prefix)) {
    return path.slice(prefix.length)
  }
  const depth = prefix.split('/').filter(Boolean).length

  return '../'.repeat(depth) + path
}

// git diff --numstat -z 的输出：每个文件是「加\t删\t路径」；改了名的路径是空的，后面跟旧路径、新路径；
// 二进制文件的加删是 -，记成 0
export const parseNumstat = (out: string, prefix: string): HudFileEdit[] => {
  const parts = out.split('\0')
  const files: HudFileEdit[] = []
  for (let i = 0; i < parts.length; i += 1) {
    const m = (parts[i] ?? '').match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/)
    if (!m) {
      continue
    }
    let path = m[3] ?? ''
    if (path === '') {
      path = parts[i + 2] ?? ''
      i += 2
    }
    if (path) {
      files.push({
        path: fromPrefix(path, prefix),
        added: m[1] === '-' ? 0 : Number(m[1]),
        removed: m[2] === '-' ? 0 : Number(m[2]),
      })
    }
  }

  return files.slice(0, FILES_MAX)
}
