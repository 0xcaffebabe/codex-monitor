#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MAC_MONITOR_NODE=${MONITOR_NODE:-}
if [ -z "$MAC_MONITOR_NODE" ]; then
  MAC_MONITOR_NODE=$(command -v node || true)
  if [ -z "$MAC_MONITOR_NODE" ] || ! "$MAC_MONITOR_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
    MAC_MONITOR_NODE=
    for candidate in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
      if [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
        MAC_MONITOR_NODE=$candidate
      fi
    done
  fi
fi
if [ -z "$MAC_MONITOR_NODE" ]; then
  echo 'Node.js 24+ is required. Set MONITOR_NODE to its absolute path.' >&2
  exit 1
fi
exec "$MAC_MONITOR_NODE" "$SCRIPT_DIR/macos-client.mjs" "$@"
