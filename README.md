# fee-hud

A Claude Code plugin that adds a `[Fee💰]` line to your statusLine showing real-time token I/O, cache hit %, session cost, today's cost, and weekly run-out estimate. Designed to sit underneath [oh-my-claudecode (omc)](https://github.com/Yeachan-Heo/oh-my-claudecode)'s existing HUD without disturbing it.

```
repo:my-project | branch:feature/x
[OMC#4.7.10] | 5h:[###-----]35% wk:[--------]3% | thinking | session:33m | ctx:13% | 🔧 41
[Fee💰] | token: 25.4M in · 295K out | cache: 94% | session $84.7 | today $23.4 | Run out in 3d7h
```

| Field | Source | What it means | Color |
|---|---|---|---|
| `token: X in · Y out` | current transcript jsonl | Total input/output tokens for the current Claude Code session (includes cache_read + cache_creation in `in`, codex-style) | green / red |
| `cache: %` | transcript jsonl | `cache_read_input_tokens` / total input — how much of your input is being served from prompt cache | purple |
| `session $` | transcript jsonl + local model price table | Estimated cost for the current Claude Code session | yellow |
| `today $` | `ccusage daily --since today` | Total spend today across all completed sessions | orange |
| `Run out in` | omc usage cache (weeklyPercent + weeklyResetsAt) | Linear projection: based on the average burn rate since the weekly window started, how long until 100% | cyan |

## Requirements

- macOS (uses `launchd` for the background aggregator)
- Claude Code with [omc](https://github.com/Yeachan-Heo/oh-my-claudecode) installed (the wrapper transparently proxies omc-hud and appends one line)
- Node.js + npm
- `ccusage` (installed automatically by `/fee-hud:setup`)

## Install

```bash
# 1. Add this marketplace
claude plugin marketplace add JunwenLu7777/Fee

# 2. Install the plugin
claude plugin install fee-hud@fee

# 3. Run setup (inside Claude Code)
/fee-hud:setup

# 4. Restart Claude Code (Cmd+Q + reopen) to activate the new statusLine
```

`/fee-hud:setup` will:

1. `npm i -g ccusage` if not already installed
2. Copy `hud-wrapper.mjs` and `ccusage-aggregator.sh` to `~/.claude/hud-extras/`
3. Generate a launchd plist with your `$HOME` baked in and load it (refresh every 60s)
4. Update `~/.claude/settings.json` to point `statusLine.command` at the wrapper (with backup)

## Uninstall

```bash
/fee-hud:uninstall          # inside Claude Code
claude plugin uninstall fee-hud@fee
```

`/fee-hud:uninstall` unloads the launchd service and restores your original `statusLine.command`. Cached scripts in `~/.claude/hud-extras/` and the `ccusage` npm package are left alone in case you want to reinstall — see the README of `/fee-hud:uninstall` for full cleanup commands.

## How it works

```
launchd service (every 60s)
  └─ ccusage-aggregator.sh
      └─ runs ccusage blocks --active and ccusage daily --today
      └─ writes ~/.claude/hud-extras/ccusage-cache.json

Claude Code statusLine (every render)
  └─ hud-wrapper.mjs
      ├─ stdin → omc-hud.mjs (transparent proxy) → captures multi-line output
      ├─ reads transcript_path from stdin context, computes session token/cost from jsonl
      ├─ reads ccusage-cache.json for today's cost
      ├─ reads omc usage cache for weekly % and reset time
      └─ outputs original omc lines + a single appended [Fee💰] line
```

Cost is computed using a small local model price table (opus / sonnet / haiku) rather than calling out to ccusage on the hot path — keeps the statusLine refresh under 200ms.

## Caveats

- **`session $` vs `today $` may look off**: `today` lags because ccusage doesn't index the currently-open session until it's closed. The `session` number is real-time from the transcript, so combined view = "what I've spent on completed sessions" + "what I'm spending right now".
- **`Run out in` uses the weekly average since reset**: early in the week (small denominator) it can swing wildly. It stabilises after a day or two of usage. This is a deliberate trade-off — sampling the live rate would require a history file, which adds complexity.
- **macOS only for now**: launchd is mac-specific. Linux support would need a systemd user unit instead. PRs welcome.

## License

MIT — see [LICENSE](./LICENSE)
