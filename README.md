# hud

Claude Code 的 mod：在输入框下方显示自定义 HUD——模型、上下文、花费、限额、分支、本轮计时等。`/hud` 可切换开关。

另外每轮回复的最后一段下面有个暗色的 `copy`，鼠标指到它时前面出现 `❯`，点一下把这段放进剪贴板（全屏模式下才能点）。

## 安装（新机器）

1. 克隆到 mods 目录：

   ```sh
   git clone git@github.com:JunwenLu7777/Fee.git ~/.claude/mods/hud
   ```

2. 在 `~/.claude/settings.json` 的 `env` 里加上（已有其他目录就用 `:` 连接）：

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/hud"
     }
   }
   ```

3. 重启 Claude Code。

更新：`git -C ~/.claude/mods/hud pull`。

## 开发

- `claude plugin validate .` 校验
- `claude plugin test .` 跑测试
- `.claude-plugin/types/` 由引擎加载 mod 时自动生成，已被忽略；加载过一次后可用 `tsc -p .` 做类型检查
