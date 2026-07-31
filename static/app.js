/* serialPortUI - front-end logic.
 *
 * Talks to the Flask + SocketIO back-end:
 *  - REST endpoints /api/ports, /api/connect, /api/disconnect,
 *    /api/send, /api/history, /api/clear
 *  - SocketIO events: ports_update, serial_status, serial_data
 */

const socket = io();
const $ = (id) => document.getElementById(id);

// State ----------------------------------------------------------------
const state = {
  ports: [],
  connected: false,
  activeDevice: null,
  historyLoadedFor: null,
};

// Helpers --------------------------------------------------------------
function setStatus(text, kind = "") {
  const pill = $("statusPill");
  pill.textContent = text;
  pill.className = "status-pill " + kind;
}

function setConnectedUI(on) {
  $("connectBtn").disabled = on;
  $("disconnectBtn").disabled = !on;
  $("sendBtn").disabled = !on;
  $("portSelect").disabled = on;
  $("baudInput").disabled = on;
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString();
}

function formatEntry(msg) {
  const tag = msg.direction === "tx" ? "TX" : "RX";
  const body = (msg.data_text || "").length && msg.data_text.indexOf("<binary") !== 0
    ? msg.data_text
    : msg.data_hex;
  const dir = document.createElement("div");
  dir.className = "entry " + msg.direction;
  dir.innerHTML =
    `<span class="meta">${fmtTime(msg.timestamp)}</span>` +
    `<span class="tag">${tag}</span>` +
    `<span class="data"></span>`;
  dir.querySelector(".data").textContent = body;
  return dir;
}

function renderPorts(ports) {
  state.ports = ports;
  const sel = $("portSelect");
  const prev = sel.value;

  sel.innerHTML = "";
  if (!ports.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no devices found)";
    sel.appendChild(opt);
  } else {
    ports.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.device;
      const desc = p.description ? ` — ${p.description}` : "";
      opt.textContent = `${p.device}${desc}`;
      sel.appendChild(opt);
    });
    if (prev && ports.some((p) => p.device === prev)) {
      sel.value = prev;
    } else if (state.activeDevice && ports.some((p) => p.device === state.activeDevice)) {
      sel.value = state.activeDevice;
    }
  }

  $("portCount").textContent = ports.length;
  $("lastPoll").textContent = new Date().toLocaleTimeString();
}

async function loadHistory(device) {
  if (!device) return;
  const activity = $("activity");
  activity.innerHTML = '<div class="empty">Loading history...</div>';
  try {
    const res = await fetch(`/api/history?device=${encodeURIComponent(device)}&limit=500`);
    const data = await res.json();
    renderHistory(data.messages || []);
    state.historyLoadedFor = device;
  } catch (e) {
    activity.innerHTML = '<div class="empty">Failed to load history.</div>';
  }
}

function renderHistory(messages) {
  const activity = $("activity");
  activity.innerHTML = "";
  if (!messages.length) {
    activity.innerHTML = '<div class="empty">No history yet for this device.</div>';
    return;
  }
  messages.forEach((m) => activity.appendChild(formatEntry(m)));
  activity.scrollTop = activity.scrollHeight;
}

function appendLive(msg) {
  if (msg.device !== state.activeDevice) return;
  if (msg.direction === "rx" && !$("showRx").checked) return;
  if (msg.direction === "tx" && !$("showTx").checked) return;

  const activity = $("activity");
  const empty = activity.querySelector(".empty");
  if (empty) activity.innerHTML = "";
  const wasAtBottom =
    activity.scrollHeight - activity.scrollTop - activity.clientHeight < 40;
  activity.appendChild(formatEntry(msg));
  if (wasAtBottom) activity.scrollTop = activity.scrollHeight;
}

// REST helpers ---------------------------------------------------------
async function refreshPorts() {
  try {
    const res = await fetch("/api/ports");
    const data = await res.json();
    renderPorts(data.ports || []);
  } catch (e) {
    console.error("refreshPorts failed", e);
  }
}

async function connect() {
  const device = $("portSelect").value;
  const baud = parseInt($("baudInput").value, 10);
  if (!device) {
    setStatus("select a device");
    return;
  }
  if (!Number.isFinite(baud) || baud <= 0) {
    setStatus("invalid baud rate", "error");
    return;
  }
  const res = await fetch("/api/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device, baud }),
  });
  const data = await res.json();
  if (!data.ok) {
    setStatus(data.error || "connect failed", "error");
    return;
  }
  state.activeDevice = data.device;
  $("activeDeviceLabel").textContent = `(${data.device} @ ${data.baud})`;
}

async function disconnect() {
  await fetch("/api/disconnect", { method: "POST" });
  state.activeDevice = null;
  $("activeDeviceLabel").textContent = "(no device)";
}

async function send() {
  const data = $("sendInput").value;
  const encoding = document.querySelector('input[name="encoding"]:checked').value;
  if (!data) return;
  const fb = $("sendFeedback");
  fb.textContent = "sending...";
  const res = await fetch("/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, encoding }),
  });
  const payload = await res.json();
  if (payload.ok) {
    fb.textContent = `sent ${payload.bytes_sent} byte(s)`;
    $("sendInput").value = "";
  } else {
    fb.textContent = payload.error || "send failed";
  }
  setTimeout(() => (fb.textContent = ""), 2500);
}

async function clearHistory() {
  if (!state.activeDevice) return;
  if (!confirm(`Clear history for ${state.activeDevice}?`)) return;
  await fetch("/api/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device: state.activeDevice }),
  });
  $("activity").innerHTML = '<div class="empty">No history yet for this device.</div>';
}

// Wire up --------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  $("refreshBtn").addEventListener("click", refreshPorts);
  $("connectBtn").addEventListener("click", connect);
  $("disconnectBtn").addEventListener("click", disconnect);
  $("sendBtn").addEventListener("click", send);
  $("loadHistoryBtn").addEventListener("click", () => loadHistory(state.activeDevice));
  $("clearHistoryBtn").addEventListener("click", clearHistory);

  $("sendInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });

  $("showRx").addEventListener("change", () => loadHistory(state.activeDevice));
  $("showTx").addEventListener("change", () => loadHistory(state.activeDevice));

  // Honour re-selecting a different device from the drop-down even when
  // already connected - lets the user preview its history.
  $("portSelect").addEventListener("change", (e) => {
    const newDevice = e.target.value;
    if (newDevice !== state.historyLoadedFor) loadHistory(newDevice);
  });

  // SocketIO bindings
  socket.on("ports_update", (msg) => renderPorts(msg.ports || []));
  socket.on("serial_status", (msg) => {
    if (msg.state === "connected") {
      state.activeDevice = msg.device;
      $("activeDeviceLabel").textContent = `(${msg.device} @ ${msg.baud})`;
      setStatus(`connected to ${msg.device}`, "connected");
      setConnectedUI(true);
      loadHistory(msg.device);
    } else if (msg.state === "disconnected") {
      setStatus("disconnected");
      setConnectedUI(false);
    } else if (msg.state === "error") {
      setStatus(msg.message || "error", "error");
      setConnectedUI(false);
    }
  });
  socket.on("serial_data", appendLive);

  // Initial populate
  refreshPorts();
});
