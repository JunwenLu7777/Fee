---
description: Remove fee-hud (unload launchd service and restore original statusLine command)
---

# fee-hud uninstall

This will:

1. Unload and remove the launchd aggregator service
2. Restore your original `statusLine.command` in `~/.claude/settings.json` (using the `preFeeCommand` backup that install saved)

It will NOT:

- Delete `~/.claude/hud-extras/` (cached scripts + ccusage cache) — left alone in case you reinstall
- Uninstall the `ccusage` npm package — left alone in case other tools use it

Run the uninstaller:

```bash
UNINSTALLER=$(find "$HOME/.claude/plugins/cache" -path '*fee-hud*/scripts/uninstall.sh' -type f 2>/dev/null | head -1)
if [ -z "$UNINSTALLER" ]; then
  echo "Uninstaller not found in plugin cache."
  exit 1
fi
bash "$UNINSTALLER"
```

After uninstall, restart Claude Code to revert the statusLine.

For full cleanup including cache and ccusage:

```bash
rm -rf "$HOME/.claude/hud-extras"
npm uninstall -g ccusage
```
