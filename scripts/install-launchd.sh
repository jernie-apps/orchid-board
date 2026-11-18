#!/bin/bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }

action=${1:-}
case "$action" in
  install|uninstall) ;;
  *) fail "Usage: $0 {install|uninstall} [--dry-run]" ;;
esac
dry_run=false
if [[ ${2:-} == --dry-run && $# == 2 ]]; then
  dry_run=true
elif [[ $# != 1 ]]; then
  fail "Usage: $0 {install|uninstall} [--dry-run]"
fi

[[ $(uname -s) == Darwin && $UID != 0 ]] || fail 'Run this as the logged-in macOS user, without sudo.'
repo=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
state="$HOME/.orchid/board"
agent_dir="$HOME/Library/LaunchAgents"
domain="gui/$UID"
board=com.orchid-board.board
proxy=com.orchid-board.caddy

unload() {
  local label=$1
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label"
  fi
}

if [[ $dry_run == false ]]; then
  launchctl print "$domain" >/dev/null 2>&1 || fail 'No GUI launchd domain. Log into the Mac desktop first.'
fi

if [[ $action == uninstall ]]; then
  for label in "$proxy" "$board"; do
    if [[ $dry_run == true ]]; then
      printf '[dry-run] Boot out %s/%s if loaded; remove %s/%s.plist\n' "$domain" "$label" "$agent_dir" "$label"
    else
      unload "$label"
      rm -f -- "$agent_dir/$label.plist"
    fi
  done
  printf 'Board data, logs, and certificate trust are not removed.\n'
  exit 0
fi

node=$(type -P node) || fail 'Install Node 22.18 or newer and put it on PATH.'
caddy=$(type -P caddy) || fail 'Install Caddy and put it on PATH (brew install caddy).'
[[ $node == /* && $caddy == /* ]] || fail 'Node and Caddy must resolve to absolute paths.'
"$node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1);' ||
  fail 'Install Node 22.18 or newer.'

for name in github.token mcp.token web.passphrase; do
  file="$state/$name"
  [[ -f $file && ! -L $file && $(stat -f '%Lp' "$file") == 600 ]] || fail "Expected a regular file with mode 600: $file"
done

port=$(cd "$repo" && "$node" --input-type=module - "$state" <<'JS'
import { loadConfig } from './src/config.ts';
try {
  const { port, mcpPort } = loadConfig(process.argv[2]);
  if (port === mcpPort) throw new Error('Web and MCP ports must differ.');
  if (port === 443 || mcpPort === 443) throw new Error('Port 443 is reserved for Caddy.');
  console.log(port);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
JS
)
ORCHID_BOARD_PORT="$port" "$caddy" adapt --config "$repo/deploy/Caddyfile" --adapter caddyfile >/dev/null

stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
for label in "$board" "$proxy"; do
  template="$repo/deploy/launchd/$label.plist"
  "$node" --input-type=module - "$template" "$stage/$label.plist" "$repo" "$node" "$HOME" "$caddy" "$port" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [template, output, repo, node, home, caddy, port] = process.argv.slice(2);
const values = { __REPO__: repo, __NODE__: node, __HOME__: home, __CADDY__: caddy, __PORT__: port };
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const plist = readFileSync(template, 'utf8').replace(/__[A-Z]+__/g, token =>
  values[token].replace(/[&<>]/g, character => entities[character]));
writeFileSync(output, plist);
JS
  plutil -lint "$stage/$label.plist" >/dev/null
done

if [[ $dry_run == true ]]; then
  printf '[dry-run] Validated Caddyfile and both rendered plists. HTTPS -> 127.0.0.1:%s.\n' "$port"
  printf '[dry-run] Create log and Caddy state directories under %s\n' "$state"
  printf '[dry-run] Refresh both plists in %s and bootstrap in %s\n' "$agent_dir" "$domain"
  exit 0
fi

mkdir -p -- "$agent_dir" "$state/logs" "$state/caddy-data" "$state/caddy-config"
chmod 700 "$state/caddy-data" "$state/caddy-config"
unload "$proxy"
unload "$board"
for label in "$board" "$proxy"; do
  install -m 644 -- "$stage/$label.plist" "$agent_dir/$label.plist"
  launchctl bootstrap "$domain" "$agent_dir/$label.plist"
done
printf 'Started %s and %s. Logs: %s/logs\n' "$board" "$proxy" "$state"
