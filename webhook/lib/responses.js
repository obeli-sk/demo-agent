// Walk the session notification stream into the transcript and live UI state.

import { getExecutionResponses, getLatestExecutionResponses } from "./obelisk-api.js";
import {
    emptyMarkers,
    projectLatestWindow,
    scanMarkers,
    sessionEventEndsTurn,
    sessionEventList,
} from "../../shared/session-state.js";
import { createTimeline } from "../../shared/session-timeline.js";

const SESSION_EVENTS_JOIN_SET = "n:session-events";

export async function loadResponses(execId) {
    const timeline = createTimeline();
    const markers = emptyMarkers();
    const state = { humanInputEvents: [], sessionStarted: undefined, inputOffer: undefined, agentWorking: undefined };
    let cursor = 0;
    let including = true;
    while (true) {
        let payload;
        try {
            payload = await getExecutionResponses(execId, SESSION_EVENTS_JOIN_SET, cursor, including, 200);
        } catch (_) { break; }
        for (const r of payload.responses || []) {
            // record-output batches several events into one response; each
            // element is applied in order, same as separate rows.
            const createdAt = r.event?.created_at || "";
            for (const value of sessionEventList(r)) {
                timeline.apply(value, createdAt);
                scanMarkers(markers, value);
                applyLiveState(state, value, createdAt);
            }
        }
        const next = payload.scan_cursor;
        if (typeof next !== "number" || next <= cursor) break;
        cursor = next;
        including = false;
        if (typeof payload.max_cursor === "number" && cursor >= payload.max_cursor) break;
    }
    return { ...state, timeline: timeline.finish(), markers, responseCursor: cursor };
}

// Bounded latest-window scan for the live working flag plus the terminal markers
// the state projection needs.
export async function loadLatestAgentState(execId) {
    let payload;
    try { payload = await getLatestExecutionResponses(execId, SESSION_EVENTS_JOIN_SET, 50); }
    catch (_) { return { working: false, markers: emptyMarkers() }; }
    const scan = projectLatestWindow(payload.responses || []);
    return { working: scan.working === true, markers: scan.markers };
}

// Non-timeline facts: session header, current input offer, working flag, ask_user gates.
function applyLiveState(target, event, createdAt) {
    if (!event || typeof event !== "object") return;
    if (sessionEventEndsTurn(event)) target.inputOffer = null;
    if (event.session_started) {
        const started = event.session_started;
        target.sessionStarted = {
            protocol_version: started.protocol_version,
            prompt: typeof started.prompt === "string" ? started.prompt : "",
            backend: typeof started.backend === "string" ? started.backend : "",
            effort: typeof started.effort === "string" ? started.effort : "",
            system_prompt: typeof started.system_prompt === "string" ? started.system_prompt : "",
            created_at: createdAt,
        };
    } else if (event.input_offered) {
        const offer = event.input_offered;
        target.inputOffer = {
            id: typeof offer.execution_id === "string" ? offer.execution_id : "",
            turn_index: Number.isInteger(offer.turn_index) ? offer.turn_index : null,
        };
    } else if (event.agent_status) {
        target.agentWorking = event.agent_status.working === true;
    } else if (event.human_input_requested) {
        const requested = event.human_input_requested;
        target.humanInputEvents.push({
            kind: "requested",
            id: typeof requested.execution_id === "string" ? requested.execution_id : "",
            question: typeof requested.question === "string" ? requested.question : "",
            turn_index: Number.isInteger(requested.turn_index) ? requested.turn_index : null,
        });
    } else if (event.human_input_resolved) {
        const resolved = event.human_input_resolved;
        target.humanInputEvents.push({
            kind: "resolved",
            id: typeof resolved.execution_id === "string" ? resolved.execution_id : "",
            turn_index: Number.isInteger(resolved.turn_index) ? resolved.turn_index : null,
        });
    }
}

export function parseJoinName(joinSetId) {
    // One-off join sets use "o:<ordinal>-<name>"; named join sets use "n:<name>".
    if (typeof joinSetId !== "string") return "";
    const name = rawJoinName(joinSetId);
    return /^user-\d+$/.test(name) ? "user" : name;
}

function rawJoinName(joinSetId) {
    if (typeof joinSetId !== "string") return "";
    if (joinSetId.startsWith("n:")) return joinSetId.substring(2);
    const dash = joinSetId.indexOf("-");
    return dash === -1 ? "" : joinSetId.substring(dash + 1);
}
