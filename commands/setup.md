---
description: One-time setup for fee-hud (installs ccusage, configures launchd, updates settings.json)
---

# fee-hud setup

This will install everything needed for the `[Fee💰]` line on your Claude Code statusLine:

1. Install `ccusage` globally via npm (if not already installed)
2. Copy the HUD wrapper and aggregator scripts to `~/.claude/hud-extras/`
3. Generate a launchd plist with your `$HOME` baked in and load the service (refreshes ccusage data every 60s)
4. Update `~/.claude/settings.json` to point `statusLine.command` at the wrapper (with backup)

Run the installer that ships with this plugin:

```bash
INSTALLER=$(find "$HOME/.claude/plugins/cache" -path '*fee-hud*/scripts/install.sh' -type f 2>/dev/null | head -1)
if [ -z "$INSTALLER" ]; then
  echo "Installer not found. Did you run: claude plugin install fee-hud@fee ?"
  exit 1
fi
bash "$INSTALLER"
```

After install completes, restart Claude Code (Cmd+Q and reopen) to activate the new statusLine.

To remove later: run `/fee-hud:uninstall`.
