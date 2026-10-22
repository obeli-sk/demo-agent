#!/usr/bin/env bash
# End-to-end smoke test: runs deployment.mock.toml on a throwaway server and
# drives one turn through the webhook API, asserting the mock LLM's fetch_url
# tool call ran for real and its result reached the final answer.
#
# Usage: ./scripts/e2e-mock.sh
# Requires: obelisk, curl, jq (via `nix develop`). fetch_url targets the dummy /demo webhook.
# Ports default to non-standard ones so a local dev server can keep running;
# override with E2E_API_PORT, E2E_WEBUI_PORT, E2E_WEBHOOK_PORT.

set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT="${E2E_API_PORT:-15005}"
WEBUI_PORT="${E2E_WEBUI_PORT:-18080}"
WEBHOOK_PORT="${E2E_WEBHOOK_PORT:-19090}"
TIMEOUT_SECS="${E2E_TIMEOUT_SECS:-60}"
WEBHOOK="http://127.0.0.1:${WEBHOOK_PORT}"

TMP="$(mktemp -d)"
cat > "$TMP/server.toml" <<EOF
api.listening_addr = "127.0.0.1:${API_PORT}"
webui.listening_addr = "127.0.0.1:${WEBUI_PORT}"
external.listening_addr = "127.0.0.1:${WEBHOOK_PORT}"

[database.sqlite]
directory = "$TMP/sqlite"
EOF

export FETCH_ALLOWED_HOST="$WEBHOOK"
export MOCK_FETCH_URL="$WEBHOOK/demo"

obelisk server run -d deployment.mock.toml --server-config "$TMP/server.toml" \
    --app-config app.mock.toml > "$TMP/server.log" 2>&1 &
SERVER_PID=$!

cleanup() {
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    echo "--- server log (tail) ---" >&2
    tail -n 50 "$TMP/server.log" >&2
    exit 1
}

deadline=$((SECONDS + TIMEOUT_SECS))
until curl -sf "$WEBHOOK/api/models" > /dev/null; do
    kill -0 "$SERVER_PID" 2>/dev/null || fail "server exited during startup"
    ((SECONDS < deadline)) || fail "server not ready within ${TIMEOUT_SECS}s"
    sleep 1
done

EXECUTION_ID="$(curl -sf -X POST "$WEBHOOK/api/submit" \
    -d '{"prompt":"e2e: demonstrate a tool call","backend":"mock"}' | jq -er .execution_id)" \
    || fail "submit failed"
echo "submitted $EXECUTION_ID"

deadline=$((SECONDS + TIMEOUT_SECS))
while true; do
    RUN="$(curl -sf "$WEBHOOK/api/runs/$EXECUTION_ID" || true)"
    if [[ -n "$RUN" ]] && jq -e '.transcript.timeline | any(.turn_complete)' <<< "$RUN" > /dev/null; then
        break
    fi
    ((SECONDS < deadline)) || fail "turn did not complete within ${TIMEOUT_SECS}s; last run: ${RUN:0:2000}"
    sleep 1
done

jq -e '[.transcript.timeline[] | select(.kind == "error")] | length == 0' <<< "$RUN" > /dev/null \
    || fail "agent errors: $(jq -c '[.transcript.timeline[] | select(.kind == "error")]' <<< "$RUN")"
jq -e '[.transcript.timeline[] | select(.kind == "reply")][0].tool_calls[0].name == "fetch_url"' <<< "$RUN" > /dev/null \
    || fail "first reply is not a fetch_url tool call: $(jq -c '[.transcript.timeline[] | select(.kind == "reply")][0]' <<< "$RUN")"
jq -e '[.transcript.timeline[] | .tool_calls[]? | select(.name == "fetch_url") | .result.ok // empty] | any(fromjson | .status == 200)' <<< "$RUN" > /dev/null \
    || fail "no successful fetch_url result: $(jq -c '.transcript.timeline' <<< "$RUN" | head -c 2000)"
# The final answer quotes the status, which the mock reads back from history via the Obelisk API.
FINAL="$(jq -r '.transcript.timeline | map(select(.turn_complete)) | last | .response' <<< "$RUN")"
[[ "$FINAL" == *"returned HTTP 200"* ]] || fail "unexpected final answer: $FINAL"

echo "PASS: $FINAL"
