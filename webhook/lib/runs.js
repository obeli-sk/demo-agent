// Run listing (sidebar) and per-run detail assembly: normalise an execution and
// its session-event stream into the timeline, status, and pending
// human-gate shape the UI renders.

import {
    getExecutionLogs,
    getExecutionRecord,
    getExecutionStatus,
    listExecutions,
} from "./obelisk-api.js";
import { loadLatestAgentState, loadResponses, parseJoinName } from "./responses.js";
import { SESSION_STATE_LABELS, emptyMarkers, projectSessionState } from "../../shared/session-state.js";

const WORKFLOW_FFQN = "agent-template:workflow/workflow.run-cancellable";

function pickRunState(workflowStatus) {
    const ps = workflowStatus?.pending_state || null;
    return {
        status: ps?.status || "unknown",
        result_kind: ps?.result_kind ?? null,
        join_name: parseJoinName(ps?.join_set_id),
    };
}

function projectRun(runState, working, markers) {
    const state = projectSessionState({
        status: runState.status,
        resultKind: runState.result_kind,
        joinName: runState.join_name,
        working,
        markers,
    });
    const [label, cls] = SESSION_STATE_LABELS[state];
    return { state, label, cls };
}

export async function listRuns() {
    const executions = await listExecutions(WORKFLOW_FFQN, "", false, false, 100);
    const runs = await Promise.all(executions.map(async (e) => {
        const id = e.execution_id;
        const runState = pickRunState(e);
        const latest = await loadLatestAgentState(id);
        const working = runState.status === "blocked_by_join_set" && runState.join_name === "user" && latest.working;
        return {
            id,
            created_at: e.created_at || "",
            ...runState,
            working,
            ...projectRun(runState, latest.working, latest.markers || emptyMarkers()),
        };
    }));
    // Newest first.
    runs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { runs };
}

export async function detailRun(id) {
    const [status, walk, finalResult] = await Promise.all([
        loadStatus(id),
        loadResponses(id),
        loadFinalResult(id),
    ]);
    const started = walk.sessionStarted;
    const runState = pickRunState(status);
    return {
        id,
        ...runState,
        ...projectRun(runState, walk.agentWorking === true, walk.markers),
        created_at: status?.created_at || "",
        backend: started?.backend || null,
        effort: started?.effort || null,
        system_prompt: started?.system_prompt || null,
        transcript: {
            timeline: walk.timeline,
            human_input_events: walk.humanInputEvents,
            session_started: started,
            input_offer: walk.inputOffer,
            agent_working: walk.agentWorking,
        },
        final_result: finalResult,
    };
}

async function loadStatus(id) {
    try { return await getExecutionStatus(id); }
    catch (_) { return null; }
}

async function loadFinalResult(id) {
    try {
        const status = await getExecutionStatus(id);
        if (status?.pending_state?.status !== "finished") return null;
        return await getExecutionRecord(id);
    } catch (e) { return { error: String(e) }; }
}

// Logs are loaded lazily from a separate endpoint because a run can have many
// derived executions (the LLM, tool, and stub children).
export async function loadExecutionTreeLogs(workflowId, startCursor) {
    const logs = [];
    let cursor = startCursor || "";
    let including = false;
    while (true) {
        let page;
        try {
            page = await getExecutionLogs(workflowId, true, cursor, including, 200);
        } catch (_) { break; }
        if (!Array.isArray(page) || page.length === 0) break;
        logs.push(...page);
        const next = page[page.length - 1]?.cursor;
        if (typeof next !== "string" || !next || next === cursor) break;
        cursor = next;
        including = false;
        if (page.length < 200) break;
    }
    return { logs, cursor: startCursor && logs.length === 0 ? startCursor : cursor };
}
