// Folds the session-event notification stream into the ordered timeline the UI
// renders. Stream order is the source of truth; the only reordering is that a
// prompt injected while an LLM call is in flight is placed after that call's
// reply, because the model only sees it in the following request.

import { sessionEventEndsTurn } from "./session-state.js";

export function createTimeline() {
    const entries = [];
    const deferred = [];
    let llmInFlight = false;
    let turnStartedAt = null;
    let lastReply = null;

    function flushDeferred() {
        entries.push(...deferred.splice(0));
    }

    function endTurn(entry, createdAt) {
        entry.turn_complete = true;
        const latency = elapsedMs(turnStartedAt, createdAt);
        if (latency !== null) entry.turn_latency_ms = latency;
        turnStartedAt = null;
    }

    function apply(event, createdAt) {
        if (!event || typeof event !== "object") return;
        if (event.session_started) {
            const prompt = event.session_started.prompt;
            if (typeof prompt === "string" && prompt.trim()) {
                entries.push({ kind: "user", id: "prompt", text: prompt, created_at: createdAt });
            }
        } else if (event.agent_status) {
            // Every LLM request is preceded by working=true, so it marks a
            // request snapshot: deferred prompts are part of it.
            if (event.agent_status.working === true) {
                flushDeferred();
                llmInFlight = true;
                if (turnStartedAt === null) turnStartedAt = createdAt;
            } else {
                flushDeferred();
                llmInFlight = false;
            }
        } else if (event.user_message) {
            const message = event.user_message;
            const entry = { kind: "user", id: message.id || "", text: message.text || "", created_at: createdAt };
            if (llmInFlight) deferred.push(entry);
            else entries.push(entry);
        } else if (event.assistant_reply) {
            llmInFlight = false;
            lastReply = replyEntry(event.assistant_reply, createdAt);
            if (!lastReply) return;
            entries.push(lastReply);
            if (sessionEventEndsTurn(event)) endTurn(lastReply, createdAt);
        } else if (event.tool_result) {
            const call = lastReply?.tool_calls?.find((c) => c.id === String(event.tool_result.id || "") && !c.result);
            if (call) call.result = toolResult(event.tool_result);
        } else if (event.agent_error) {
            const error = event.agent_error;
            llmInFlight = false;
            const entry = { kind: "error", id: String(error.id || ""), text: String(error.text || ""), created_at: createdAt };
            entries.push(entry);
            if (sessionEventEndsTurn(event)) endTurn(entry, createdAt);
            flushDeferred();
        }
    }

    // Prompts still waiting on an in-flight call render at the tail.
    function finish() {
        return [...entries, ...deferred];
    }

    return { apply, finish };
}

function replyEntry(rep, createdAt) {
    if (typeof rep.content_json !== "string") return null;
    let blocks = [];
    try { blocks = JSON.parse(rep.content_json); } catch (_) { blocks = []; }
    if (!Array.isArray(blocks)) blocks = [];
    const toolUses = blocks.filter((b) => b?.type === "tool_use");
    const text = blocks.filter((b) => b?.type === "text").map((b) => b.text || "").join("");
    const entry = {
        kind: "reply",
        created_at: createdAt,
        step: Number.isInteger(rep.step) ? rep.step : null,
        duration_milliseconds: rep.duration_milliseconds,
    };
    if (toolUses.length > 0) {
        entry.narration = text;
        entry.tool_calls = toolUses.map((b) => ({ id: typeof b.id === "string" ? b.id : "", name: b.name, args: b.input || {} }));
    } else {
        entry.response = text;
    }
    return entry;
}

function toolResult(result) {
    const out = { duration_milliseconds: result.duration_milliseconds };
    if (result.output && "ok" in result.output) out.ok = result.output.ok;
    else if (result.output && "error" in result.output) out.err = result.output.error;
    return out;
}

function elapsedMs(startIso, endIso) {
    const start = parseTs(startIso);
    const end = parseTs(endIso);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

// Obelisk timestamps carry nanoseconds, which Date.parse may reject.
function parseTs(iso) {
    if (typeof iso !== "string") return NaN;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));
}
