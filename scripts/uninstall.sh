#!/bin/bash
# fee-hud uninstaller
set -e

HOME_DIR="${HOME:?HOME not set}"
HUD_DIR="$HOME_DIR/.claude/hud-extras"
PLIST="$HOME_DIR/Library/LaunchAgents/com.fee-hud.aggregator.plist"
SETTINGS="$HOME_DIR/.claude/settings.json"

echo "==> Uninstalling fee-hud..."

# ---- 1. unload launchd ----
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ launchd service removed"
fi

# ---- 2. restore settings.json ----
if [ -f "$SETTINGS" ]; then
  node - "$SETTINGS" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
let s;
try { s = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { process.exit(0); }
if (!s.statusLine) { console.log('No statusLine block to clean'); process.exit(0); }
const orig = s.statusLine.preFeeCommand;
if (orig) {
  s.statusLine.command = orig;
  delete s.statusLine.preFeeCommand;
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  console.log('✓ Restored statusLine.command to:', orig);
} else {
  console.log('No preFeeCommand backup found — leaving statusLine as-is.');
  console.log('  If you want to remove statusLine entirely, edit', p, 'manually.');
}
NODE
fi

echo ""
echo "✓ fee-hud uninstalled (Claude Code restart required)"
echo ""
echo "Optional cleanup:"
echo "  rm -rf $HUD_DIR              # cached scripts + ccusage cache"
echo "  npm uninstall -g ccusage     # if not used elsewhere"
