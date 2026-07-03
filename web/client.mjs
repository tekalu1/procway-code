const params = new URLSearchParams(location.search);
const token = params.get("token") ?? "";

const statusEl = document.getElementById("status");
const sessionEl = document.getElementById("session");
const logEl = document.getElementById("event-log");
const formEl = document.getElementById("prompt-form");
const inputEl = document.getElementById("prompt-input");
const submitEl = document.getElementById("prompt-submit");
const abortEl = document.getElementById("abort-btn");
const approvalEl = document.getElementById("approval-panel");
const approvalSummaryEl = document.getElementById("approval-summary");
const sessionListEl = document.getElementById("session-list");
const refreshSessionsEl = document.getElementById("refresh-sessions");

let nextRequestId = 1;
const pendingApproval = { requestId: null };
const pendingResponses = new Map();

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function appendLog(line) {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function renderTranscript(transcript) {
  logEl.textContent = "";
  if (!Array.isArray(transcript)) return;
  for (const node of transcript) {
    if (!node || typeof node !== "object") continue;
    const text = typeof node.text === "string" ? node.text : "";
    if (node.kind === "user") appendLog(`> ${text}`);
    else if (node.kind === "assistant") appendLog(text);
    else if (node.kind === "assistant-tool-calls") appendLog(`[tool calls] ${text}`);
    else if (node.kind === "tool") appendLog(`[tool result] ${text}`);
    else appendLog(`[${node.kind}] ${text}`);
  }
}

function renderEvent(event) {
  const time = event?.time ?? "";
  const type = event?.type ?? "?";
  switch (type) {
    case "assistant.message.delta":
      logEl.textContent += event.deltaText ?? "";
      logEl.scrollTop = logEl.scrollHeight;
      return;
    case "assistant.message.completed":
      appendLog(`\n[turn output complete]`);
      return;
    case "user.prompt.submitted": {
      const text = (event.content ?? [])
        .filter((b) => b?.kind === "text")
        .map((b) => b.text)
        .join("");
      appendLog(`\n> ${text}`);
      return;
    }
    case "approval.requested":
      pendingApproval.requestId = event.requestId;
      approvalSummaryEl.textContent = `${event.kind}: ${event.summary}`;
      approvalEl.hidden = false;
      appendLog(`[approval requested] ${event.kind}: ${event.summary}`);
      return;
    case "approval.resolved":
      approvalEl.hidden = true;
      pendingApproval.requestId = null;
      appendLog(`[approval ${event.decision}] ${event.requestId}`);
      return;
    case "tool.call.scheduled":
      appendLog(`[tool] ${event.name} ${JSON.stringify(event.args ?? {})}`);
      return;
    case "tool.call.completed":
      appendLog(`[tool result] ${event.ok ? "ok" : "err"} ${event?.result?.summary ?? ""}`);
      return;
    case "turn.completed":
      appendLog(`[turn done] round=${event.round} exit=${event.exitCode}`);
      return;
    case "turn.failed":
      appendLog(`[turn failed] ${event?.error?.message ?? "unknown"}`);
      return;
    case "session.created":
      sessionEl.textContent = `session ${event.sessionId} • ${event.provider}:${event.model}`;
      return;
    case "session.resumed":
      sessionEl.textContent = `session ${event.sessionId} • resumed (${event.messageCount} msgs)`;
      renderTranscript(event.messages ?? []);
      appendLog(`[resumed] session=${event.sessionId} messages=${event.messageCount} events=${event.eventCount}`);
      return;
    case "usage.recorded":
      appendLog(`[usage] in=${event.inputTokens} out=${event.outputTokens}`);
      return;
    default:
      appendLog(`[${type}] ${time}`);
  }
}

const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);

ws.addEventListener("open", () => {
  setStatus("connected", "connected");
  inputEl.disabled = false;
  submitEl.disabled = false;
  abortEl.disabled = false;
  if (refreshSessionsEl) refreshSessionsEl.disabled = false;
});

ws.addEventListener("close", () => {
  setStatus("disconnected", "disconnected");
  inputEl.disabled = true;
  submitEl.disabled = true;
  abortEl.disabled = true;
  if (refreshSessionsEl) refreshSessionsEl.disabled = true;
});

ws.addEventListener("error", () => {
  appendLog("[ws error]");
});

ws.addEventListener("message", (e) => {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.kind === "ready") {
    sessionEl.textContent = `session ${msg.sessionId} • v${msg.version}`;
    appendLog(`[ready] session=${msg.sessionId}`);
  } else if (msg.kind === "event") {
    renderEvent(msg.event);
  } else if (msg.kind === "response") {
    const pending = pendingResponses.get(msg.id);
    if (pending) {
      pendingResponses.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(msg.error);
    } else {
      appendLog(msg.ok ? `[response ${msg.id} ok]` : `[response ${msg.id} err: ${formatError(msg.error)}]`);
    }
  } else if (msg.kind === "error") {
    appendLog(`[error${msg.fatal ? " fatal" : ""}] ${msg.error}`);
  }
});

setStatus("connecting", "connecting…");

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const prompt = inputEl.value.trim();
  if (!prompt) return;
  inputEl.value = "";
  send("runTurn", { prompt });
});

abortEl.addEventListener("click", () => {
  send("abort", {});
});

approvalEl.querySelectorAll("button[data-decision]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!pendingApproval.requestId) return;
    send("approve", { requestId: pendingApproval.requestId, decision: btn.dataset.decision });
    approvalEl.hidden = true;
  });
});

if (refreshSessionsEl) {
  refreshSessionsEl.addEventListener("click", () => {
    refreshSessionsEl.disabled = true;
    listSessions({ limit: 50 })
      .then((result) => renderSessionList(result?.sessions ?? []))
      .catch((error) => appendLog(`[listSessions err] ${formatError(error)}`))
      .finally(() => { refreshSessionsEl.disabled = ws.readyState !== WebSocket.OPEN; });
  });
}

function renderSessionList(sessions) {
  if (!sessionListEl) return;
  sessionListEl.textContent = "";
  if (sessions.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "(no sessions)";
    sessionListEl.appendChild(empty);
    return;
  }
  for (const session of sessions) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    const titlePart = session.title ? `${session.title} ` : "";
    label.textContent = `${titlePart}(${session.sessionId}) • ${session.messageCount} msgs`;
    li.appendChild(label);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Load";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      loadSession(session.sessionId)
        .then((result) => appendLog(`[loaded] ${result.sessionId} (${result.messageCount} msgs)`))
        .catch((error) => appendLog(`[loadSession err] ${formatError(error)}`))
        .finally(() => { btn.disabled = false; });
    });
    li.appendChild(btn);
    sessionListEl.appendChild(li);
  }
}

function send(command, args) {
  if (ws.readyState !== WebSocket.OPEN) return null;
  const id = String(nextRequestId++);
  ws.send(JSON.stringify({ kind: "command", command, id, args }));
  return id;
}

function request(command, args) {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error("websocket not connected"));
      return;
    }
    const id = String(nextRequestId++);
    pendingResponses.set(id, { resolve, reject });
    ws.send(JSON.stringify({ kind: "command", command, id, args }));
  });
}

export function listSessions(args = {}) {
  return request("listSessions", args);
}

export function loadSession(sessionId) {
  return request("loadSession", { sessionId });
}

function formatError(error) {
  if (!error) return "unknown";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const code = typeof error.code === "string" ? `[${error.code}] ` : "";
    return `${code}${error.message ?? JSON.stringify(error)}`;
  }
  return String(error);
}
