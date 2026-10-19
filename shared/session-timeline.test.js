import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimeline } from "./session-timeline.js";

const toolCall = (id, url) => JSON.stringify([{ type: "tool_use", id, name: "fetch_url", input: { url } }]);
const text = (t) => JSON.stringify([{ type: "text", text: t }]);
const at = (s) => `2026-10-19T19:21:${String(s).padStart(2, "0")}.000000001Z`;

function fold(events) {
    const timeline = createTimeline();
    for (const [s, event] of events) timeline.apply(event, at(s));
    return timeline.finish();
}

function shape(entries) {
    return entries.map((e) => e.kind === "user" ? `user:${e.text}`
        : e.kind === "error" ? `error:${e.id}`
        : e.tool_calls ? `tools:${e.tool_calls.map((c) => c.args.url).join(",")}`
        : `reply:${e.response}`);
}

test("a prompt injected during an in-flight call renders after that call's reply", () => {
    const entries = fold([
        [0, { session_started: { prompt: "test" } }],
        [0, { agent_status: { working: true, turn_index: 0 } }],
        [2, { assistant_reply: { content_json: toolCall("same", "https://example.com"), turn_index: 0, step: 1, turn_complete: false } }],
        [2, { tool_result: { id: "same", name: "fetch_url", output: { error: "denied" }, turn_index: 0, step: 1 } }],
        [2, { agent_status: { working: true, turn_index: 0 } }],
        [3, { user_message: { id: "u1", text: "try obeli.sk", turn_index: 0 } }],
        // The workflow keeps turn 0 and restarts steps when a prompt is queued.
        [4, { assistant_reply: { content_json: text("denied everywhere"), turn_index: 0, step: 2, turn_complete: false } }],
        [4, { agent_status: { working: true, turn_index: 0 } }],
        [5, { assistant_reply: { content_json: toolCall("same", "https://obeli.sk"), turn_index: 0, step: 1, turn_complete: false } }],
        [5, { tool_result: { id: "same", name: "fetch_url", output: { ok: "200" }, turn_index: 0, step: 1 } }],
        [5, { agent_status: { working: true, turn_index: 0 } }],
        [7, { assistant_reply: { content_json: text("obeli.sk works"), turn_index: 0, step: 2, turn_complete: true } }],
        [7, { agent_status: { working: false, turn_index: 0 } }],
    ]);
    assert.deepEqual(shape(entries), [
        "user:test",
        "tools:https://example.com",
        "reply:denied everywhere",
        "user:try obeli.sk",
        "tools:https://obeli.sk",
        "reply:obeli.sk works",
    ]);
    assert.equal(entries[1].tool_calls[0].result.err, "denied");
    assert.equal(entries[4].tool_calls[0].result.ok, "200");
    assert.equal(entries[2].turn_complete, undefined);
    assert.equal(entries[5].turn_complete, true);
    assert.equal(entries[5].turn_latency_ms, 7000);
});

test("an idle prompt starts a new turn and a turn-ending error closes it", () => {
    const entries = fold([
        [0, { session_started: { prompt: "" } }],
        [0, { agent_status: { working: false, turn_index: 0 } }],
        [10, { user_message: { id: "u1", text: "hi", turn_index: 0 } }],
        [10, { agent_status: { working: true, turn_index: 0 } }],
        [11, { user_message: { id: "u2", text: "more", turn_index: 0 } }],
        [12, { agent_error: { id: "llm-error-0", text: "boom", turn_index: 0 } }],
        [12, { agent_status: { working: false, turn_index: 0 } }],
    ]);
    assert.deepEqual(shape(entries), ["user:hi", "error:llm-error-0", "user:more"]);
    assert.equal(entries[1].turn_latency_ms, 2000);
});
