#!/bin/sh
set -eu
MAC_MONITOR_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /bin/sh "$MAC_MONITOR_ROOT/scripts/macos-client.sh" start "$@"
