#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mock_dir="$(mktemp -d)"
obelisk_pid=""
cleanup() {
    if [[ -n "$obelisk_pid" ]]; then
        kill "$obelisk_pid" 2>/dev/null || true
        wait "$obelisk_pid" 2>/dev/null || true
    fi
    rm -r -- "$mock_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Obelisk resolves components within the deployment file's directory.
cp -R src test/deployment.mock.toml "$mock_dir/"
obelisk "$@" --deployment "$mock_dir/deployment.mock.toml" --app-config test/app.mock.toml &
obelisk_pid=$!
exit_status=0
wait "$obelisk_pid" || exit_status=$?
obelisk_pid=""
exit "$exit_status"
