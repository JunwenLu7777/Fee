#!/bin/bash
# ccusage aggregator: launchd 每 60s 调一次，把 ccusage 数据写入缓存供 HUD wrapper 读取
set -u

HUD_DIR="$HOME/.claude/hud-extras"
CACHE="$HUD_DIR/ccusage-cache.json"
LOG="$HUD_DIR/aggregator.log"
TMP_BLOCKS=$(mktemp -t ccusage-blocks)
TMP_DAILY=$(mktemp -t ccusage-daily)

trap 'rm -f "$TMP_BLOCKS" "$TMP_DAILY"' EXIT

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if ! command -v ccusage >/dev/null 2>&1; then
  echo "$(ts) ERROR ccusage not in PATH" >> "$LOG"
  exit 1
fi

BLOCKS_OK=0
DAILY_OK=0

if ccusage blocks --active --json > "$TMP_BLOCKS" 2>>"$LOG"; then
  BLOCKS_OK=1
fi

TODAY=$(date +%Y%m%d)
if ccusage daily --since "$TODAY" --until "$TODAY" --json > "$TMP_DAILY" 2>>"$LOG"; then
  DAILY_OK=1
fi

node - "$TMP_BLOCKS" "$TMP_DAILY" "$CACHE" "$BLOCKS_OK" "$DAILY_OK" <<'NODE'
const fs = require('fs');
const [,, blocksPath, dailyPath, cachePath, blocksOk, dailyOk] = process.argv;
const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  blocks: null,
  daily: null,
  errors: []
};
if (blocksOk === '1') {
  try { out.blocks = JSON.parse(fs.readFileSync(blocksPath, 'utf-8')); }
  catch (e) { out.errors.push('blocks parse: ' + e.message); }
} else { out.errors.push('blocks command failed'); }
if (dailyOk === '1') {
  try { out.daily = JSON.parse(fs.readFileSync(dailyPath, 'utf-8')); }
  catch (e) { out.errors.push('daily parse: ' + e.message); }
} else { out.errors.push('daily command failed'); }
const tmp = cachePath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(out));
fs.renameSync(tmp, cachePath);
NODE

if [ $? -eq 0 ]; then
  echo "$(ts) ok blocks=$BLOCKS_OK daily=$DAILY_OK" >> "$LOG"
else
  echo "$(ts) write cache failed" >> "$LOG"
fi

# 日志超过 200KB 截断
if [ -f "$LOG" ] && [ $(wc -c < "$LOG") -gt 204800 ]; then
  tail -c 51200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
