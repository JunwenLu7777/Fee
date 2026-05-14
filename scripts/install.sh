#!/bin/bash
# fee-hud installer: idempotent, auto-detects $HOME
# Usage: bash <plugin-cache-path>/fee-hud/<ver>/scripts/install.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOME_DIR="${HOME:?HOME not set}"
HUD_DIR="$HOME_DIR/.claude/hud-extras"

echo "==> fee-hud install"
echo "    plugin: $PLUGIN_ROOT"
echo "    home:   $HOME_DIR"
echo ""

# ---- 1. dependencies ----
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found. Install Node.js first."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found."
  exit 1
fi

# ---- 2. ccusage ----
if command -v ccusage >/dev/null 2>&1; then
  echo "✓ ccusage already installed: $(ccusage --version 2>/dev/null || echo '?')"
else
  echo "==> Installing ccusage globally..."
  npm install -g ccusage
fi

# ---- 3. copy scripts to ~/.claude/hud-extras/ ----
mkdir -p "$HUD_DIR"
cp "$PLUGIN_ROOT/bin/hud-wrapper.mjs" "$HUD_DIR/hud-wrapper.mjs"
cp "$PLUGIN_ROOT/bin/ccusage-aggregator.sh" "$HUD_DIR/ccusage-aggregator.sh"
chmod +x "$HUD_DIR/ccusage-aggregator.sh"
echo "✓ Scripts copied to $HUD_DIR"

# ---- 4. generate launchd plist with $HOME baked in ----
LAUNCHD_DIR="$HOME_DIR/Library/LaunchAgents"
PLIST="$LAUNCHD_DIR/com.fee-hud.aggregator.plist"
mkdir -p "$LAUNCHD_DIR"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.fee-hud.aggregator</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$HUD_DIR/ccusage-aggregator.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HUD_DIR/aggregator.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$HUD_DIR/aggregator.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME_DIR</string>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
EOF
echo "✓ Plist generated: $PLIST"

# ---- 5. (re)load launchd service ----
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✓ launchd service loaded"

# ---- 6. update settings.json (preserve everything else) ----
SETTINGS="$HOME_DIR/.claude/settings.json"
if [ ! -f "$SETTINGS" ]; then
  # Bootstrap minimal settings if not present
  mkdir -p "$(dirname "$SETTINGS")"
  echo '{}' > "$SETTINGS"
fi

node - "$SETTINGS" <<'NODE'
const fs = require('fs');
const path = process.argv[2];
let s;
try { s = JSON.parse(fs.readFileSync(path, 'utf-8') || '{}'); }
catch (e) { console.error('settings.json not valid JSON:', e.message); process.exit(1); }

const NEW_CMD = 'node ~/.claude/hud-extras/hud-wrapper.mjs';
s.statusLine = s.statusLine || {};
const oldCmd = s.statusLine.command;
if (oldCmd === NEW_CMD) {
  console.log('✓ settings.json already configured');
  process.exit(0);
}

// Backup original file
const bak = path + '.bak-fee-' + new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(path, bak);

// Remember pre-fee command so uninstall can restore
if (oldCmd && oldCmd !== NEW_CMD) {
  s.statusLine.preFeeCommand = oldCmd;
}
s.statusLine.type = 'command';
s.statusLine.command = NEW_CMD;
if (s.statusLine.padding == null) s.statusLine.padding = 0;

fs.writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
console.log('✓ settings.json updated. Backup at:', bak);
NODE

echo ""
echo "===================================================="
echo "  fee-hud install complete"
echo "===================================================="
echo "Next: restart Claude Code (Cmd+Q + reopen) to see the [Fee💰] line."
echo ""
echo "Verify aggregator: launchctl list com.fee-hud.aggregator"
echo "Logs:              tail $HUD_DIR/aggregator.log"
echo "Uninstall:         bash $PLUGIN_ROOT/scripts/uninstall.sh"
