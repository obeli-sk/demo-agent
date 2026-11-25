default: serve

# Run the agent. LLM_BASE_URL provides discovery; AGENT_MODELS is the fallback
# (see .envrc-example / the README). JS components need no build step.
serve:
  obelisk server run --dev -d deployment.toml --app-config app.toml

# Run with a scripted mock LLM: watch the whole loop drive a turn (a fetch_url
# tool call + its real result + a final answer) with NO LLM endpoint, key, or
# catalog. See src/activity/llm-chat-mock.js.
serve-mock:
  bash test/run-mock.sh server run --dev

# Compile, link and policy-check both deployments
verify:
  obelisk server verify --dev --skip-db --app-config app.toml -d deployment.toml
  bash test/run-mock.sh server verify --dev --skip-db

# Unit tests: pure logic, runnable offline (no Obelisk, no network).
test:
  node --test src/workflow/session-logic.test.js
  node --test src/shared/session-state.test.js
  node --test src/shared/session-timeline.test.js
  node --test src/shared/model-catalog.test.js
  node --test src/activity/fetch-url.test.js
  node --test src/activity/llm-chat-mock.test.js
  node --test src/webhook/ui/shell.test.js
  node --test src/webhook/lib/watch.test.js
  node --test src/activity/llm-history.test.js

# End-to-end: run the mock deployment on a throwaway server and drive one turn
# (a real fetch_url tool call to the dummy /demo webhook + the final answer).
e2e:
  ./scripts/e2e-mock.sh
