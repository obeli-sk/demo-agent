import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { htmlShell } from "./shell.js";

test("timeline renders entries in order with their paired tool results", async () => {
    const html = await htmlShell().text();
    const script = html.split("<script>")[1].split("</script>")[0].split('el("send").onclick')[0];
    const browser = {};
    vm.runInNewContext(script, browser);
    const transcript = {
        timeline: [
            { kind: "user", text: "first prompt" },
            { kind: "reply", tool_calls: [{ id: "same", name: "fetch_url", args: { url: "https://example.com" }, result: { err: "denied" } }] },
            { kind: "user", text: "second prompt" },
            { kind: "reply", tool_calls: [{ id: "same", name: "fetch_url", args: { url: "https://obeli.sk" }, result: { ok: '{"status":200}' } }] },
            { kind: "reply", response: "done", turn_complete: true, turn_latency_ms: 7000 },
        ],
    };
    const rendered = browser.renderTimeline(transcript);
    assert.match(rendered, /first prompt[\s\S]*example\.com[\s\S]*denied[\s\S]*second prompt[\s\S]*obeli\.sk[\s\S]*200[\s\S]*done[\s\S]*turn: 7\.0s/);
});
