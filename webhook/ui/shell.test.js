import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { htmlShell } from "./shell.js";

async function browserHarness() {
    const html = await htmlShell().text();
    const script = html.split("<script>")[1].split("</script>")[0];
    const elements = new Map();
    const listeners = {};
    const timers = new Map();
    const sources = [];
    const calls = [];
    const browser = {
        URLSearchParams,
        setTimeout(fn, delay) { const key = {}; timers.set(key, { fn, delay }); return key; },
        clearTimeout(key) { timers.delete(key); },
        document: {
            hidden: false,
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, {
                    value: "", innerHTML: "", hidden: false, options: [],
                    appendChild() {}, querySelectorAll() { return []; },
                    addEventListener() {}, focus() {},
                });
                return elements.get(id);
            },
            createElement() { return {}; },
            addEventListener(name, fn) { listeners[name] = fn; },
        },
        window: { addEventListener() {} },
        location: { search: "", pathname: "/" },
        history: { replaceState() {} },
        EventSource: class {
            constructor(url) { this.url = url; this.listeners = {}; sources.push(this); }
            addEventListener(name, fn) { this.listeners[name] = fn; }
            emit(name, data = "{}") { this.listeners[name]?.({ data }); }
            close() { this.closed = true; }
        },
        async fetch(path) {
            calls.push(path);
            const data = path.startsWith("/api/runs/")
                ? { id: decodeURIComponent(path.substring("/api/runs/".length)), status: "locked", transcript: {} }
                : {};
            return { ok: true, text: async () => JSON.stringify(data) };
        },
    };
    vm.runInNewContext(script, browser);
    await new Promise(setImmediate);
    calls.length = 0;
    return { browser, sources, calls, timers, listeners };
}

test("one watch follows the selected cursor and listed runs, with polling fallback", async () => {
    const { browser: b, sources, calls, timers, listeners } = await browserHarness();
    b.state.currentId = "E_1";
    b.state.detail = { id: "E_1", status: "locked", transcript: { response_cursor: 5 } };
    b.state.runs = [{ id: "E_1", status: "locked" }, { id: "E_2", status: "locked" }, { id: "E_3", status: "finished" }];
    b.ensureWatch(); b.ensureWatch();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, "/api/watch?run=E_1&cursor=5&ids=E_2");
    sources[0].emit("open");
    assert.deepEqual([...timers.values()].map((t) => t.delay).sort(), [15000, 60000]);
    sources[0].emit("run");
    await new Promise(setImmediate);
    assert.deepEqual(calls, ["/api/runs/E_1"]);
    sources[0].emit("error");
    assert.deepEqual([...timers.values()].map((t) => t.delay).sort(), [10000, 5000]);
    b.document.hidden = true;
    listeners.visibilitychange();
    assert.equal(sources[0].closed, true);
    assert.equal(timers.size, 0);
    b.document.hidden = false;
    listeners.visibilitychange();
    await new Promise(setImmediate);
    assert.equal(sources.length, 2);
    sources[1].emit("end");
    b.ensureWatch();
    assert.equal(sources.length, 2, "a completed watch must not immediately reopen");
});

test("changes during a detail request trigger one follow-up and stale selections cannot render", async () => {
    const { browser: b, calls } = await browserHarness();
    const pending = [];
    b.fetch = (path) => new Promise((resolve) => { calls.push(path); pending.push(resolve); });
    b.state.currentId = "E_old";
    const first = b.refreshDetail();
    b.refreshDetail(); b.refreshDetail();
    assert.equal(calls.length, 1);
    pending.shift()({ ok: true, text: async () => JSON.stringify({ id: "E_old", status: "locked", transcript: {} }) });
    await first;
    assert.equal(calls.length, 2);
    b.state.currentId = "E_new";
    b.state.detail = null;
    pending.shift()({ ok: true, text: async () => JSON.stringify({ id: "E_old", status: "finished" }) });
    await new Promise(setImmediate);
    assert.equal(b.state.detail, null);
});

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
