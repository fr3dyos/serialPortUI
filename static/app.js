/* serialPortUI - front-end logic.
 *
 * Talks to the Flask + SocketIO back-end:
 * - REST endpoints /api/ports, /api/connect, /api/disconnect,
 *   /api/send, /api/history, /api/clear
 * - SocketIO events: ports_update, serial_status, serial_data
 *
 * UI structure (matches templates/index.html):
 *   .topbar          - sticky app bar with brand + Connect button
 *   .console-area    - main flex column: head, toolbar, console frame,
 *                      send row
 *   #activity/.entry - log output (one .entry per rx/tx line)
 *   .sidebar         - right rail with connection settings + status
 *   #statusPill      - connection status LED
 */

const socket = io();
const $ = (id) => document.getElementById(id);

// ----------------------------------------------------------------------
// State
// ----------------------------------------------------------------------

const state = {
  ports: [],
  connected: false,
  activeDevice: null,
  activeBaud: null,
  historyLoadedFor: null,
  filter: "",
  autoScroll: true,
  showTime: true,
  lastError: null,
};

// Commands sent through #sendInput during this browser session.
const commandHistory = [];
let commandHistoryIndex = -1;
let commandDraft = "";

// ----------------------------------------------------------------------
// Theme
// ----------------------------------------------------------------------

const THEME_KEY = "serialPortUI:theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (_) {}

  if (saved !== "light" && saved !== "dark") {
    saved = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  applyTheme(saved);
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function setStatus(text, kind = "disconnected") {
  const pill = $("statusPill");
  pill.setAttribute("data-state", kind);
  $("statusText").textContent = text;
  $("connectBtnTxt").textContent = text === "DISCONNECTED"
    ? "CONNECT"
    : "CONNECTED";
}

function setConnectedUI(on) {
  $("connectBtn").disabled = on;
  $("disconnectBtn").disabled = !on;
  $("sendBtn").disabled = !on;
  $("sendInput").disabled = !on;
  $("portSelect").disabled = on;
  $("baudInput").disabled = on;
  $("bytesizeInput").disabled = on;
  $("parityInput").disabled = on;
  $("stopbitsInput").disabled = on;
  $("newlineInput").disabled = !on;
  $("encodingInput").disabled = !on;
  $("refreshBtn").disabled = on;
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `[${hh}:${mm}:${ss}.${ms}]`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlight(text, query) {
  if (!query) return escapeHtml(text);

  const source = String(text ?? "");
  const lower = source.toLowerCase();
  const index = lower.indexOf(query.toLowerCase());

  if (index < 0) return escapeHtml(source);

  const before = source.slice(0, index);
  const match = source.slice(index, index + query.length);
  const after = source.slice(index + query.length);

  return `${escapeHtml(before)}<span class="hit">${escapeHtml(match)}</span>${escapeHtml(after)}`;
}

function saveCommandToHistory(command) {
  const normalized = command.trim();
  if (!normalized) return;

  if (commandHistory[commandHistory.length - 1] !== normalized) {
    commandHistory.push(normalized);
  }

  commandHistoryIndex = -1;
  commandDraft = "";
}

function recallCommand(direction) {
  const input = $("sendInput");
  if (!commandHistory.length) return;

  if (direction === "up") {
    if (commandHistoryIndex === -1) {
      commandDraft = input.value;
      commandHistoryIndex = commandHistory.length - 1;
    } else if (commandHistoryIndex > 0) {
      commandHistoryIndex -= 1;
    }
  } else if (direction === "down") {
    if (commandHistoryIndex === -1) return;

    if (commandHistoryIndex < commandHistory.length - 1) {
      commandHistoryIndex += 1;
    } else {
      commandHistoryIndex = -1;
      input.value = commandDraft;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
  }

  input.value = commandHistory[commandHistoryIndex];
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

function formatEntry(msg) {
  const tag = msg.direction === "tx" ? "TX" : "RX";
  const isGroup = Array.isArray(msg.lines) && msg.lines.length > 0;
  const text = msg.data_text || "";
  const isBinary = text.startsWith("<binary");
  const body = !isBinary && text.length ? text : (msg.data_hex || "");

  const entry = document.createElement("div");
  entry.className = `entry ${msg.direction}${isGroup ? " group" : ""}`;
  entry.dataset.text = body;
  entry.dataset.hex = msg.data_hex || "";
  entry.innerHTML =
    `<span class="meta">${fmtTime(msg.timestamp)}</span>` +
    `<span class="tag">${tag}${isGroup ? ` · ${msg.lines.length}` : ""}</span>` +
    '<span class="data"></span>';

  const dataEl = entry.querySelector(".data");

  if (isGroup) {
    dataEl.classList.add("group-block");
    dataEl.innerHTML = msg.lines
      .map((line) => state.filter ? highlight(line, state.filter) : escapeHtml(line))
      .join("<br>");
  } else {
    dataEl.innerHTML = highlight(body, state.filter);
  }

  if (!state.showTime) entry.classList.add("time-hidden");
  applyFiltersToEntry(entry);
  return entry;
}

function applyFiltersToEntry(entry) {
  const isRx = entry.classList.contains("rx");
  const isTx = entry.classList.contains("tx");

  if (isRx && !$("showRx").checked) {
    entry.classList.add("hidden");
  } else if (isTx && !$("showTx").checked) {
    entry.classList.add("hidden");
  } else if (state.filter) {
    const haystack = `${entry.dataset.text || ""} ${entry.dataset.hex || ""}`;
    entry.classList.toggle("hidden", !haystack.toLowerCase().includes(state.filter));
  } else {
    entry.classList.remove("hidden");
  }
}

function applyAllFilters() {
  document.querySelectorAll("#activity .entry").forEach(applyFiltersToEntry);
}

// ----------------------------------------------------------------------
// Port list
// ----------------------------------------------------------------------

function renderPorts(ports) {
  state.ports = ports;
  const select = $("portSelect");
  const previous = select.value;
  select.innerHTML = "";

  if (!ports.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "(no devices found)";
    select.appendChild(option);
    $("portMeta").textContent = "0 devices detected.";
    return;
  }

  ports.forEach((port) => {
    const option = document.createElement("option");
    option.value = port.device;
    option.textContent = `${port.device}${port.description ? ` — ${port.description}` : ""}`;
    option.title = [
      port.description,
      port.manufacturer,
      port.vid ? `VID ${port.vid.toString(16).toUpperCase()}` : null,
      port.pid ? `PID ${port.pid.toString(16).toUpperCase()}` : null,
      port.serial_number,
    ].filter(Boolean).join(" · ");
    select.appendChild(option);
  });

  if (previous && ports.some((port) => port.device === previous)) {
    select.value = previous;
  } else if (state.activeDevice && ports.some((port) => port.device === state.activeDevice)) {
    select.value = state.activeDevice;
  }

  $("portMeta").textContent =
    `${ports.length} device(s) detected · last polled ${new Date().toLocaleTimeString()}`;
}

// ----------------------------------------------------------------------
// History
// ----------------------------------------------------------------------

async function loadHistory(device) {
  if (!device) return;

  const activity = $("activity");
  activity.innerHTML = '<div class="empty">Loading history…</div>';

  try {
    const response = await fetch(
      `/api/history?device=${encodeURIComponent(device)}&limit=500`
    );
    const data = await response.json();
    renderHistory(data.messages || []);
    state.historyLoadedFor = device;
  } catch (_) {
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

  const fragment = document.createDocumentFragment();
  messages.forEach((message) => fragment.appendChild(formatEntry(message)));
  activity.appendChild(fragment);

  if (state.autoScroll) activity.scrollTop = activity.scrollHeight;
}

function appendLive(msg) {
  if (msg.device !== state.activeDevice) return;

  const activity = $("activity");
  const empty = activity.querySelector(".empty");
  if (empty) activity.innerHTML = "";

  const wasAtBottom =
    activity.scrollHeight - activity.scrollTop - activity.clientHeight < 40;

  activity.appendChild(formatEntry(msg));

  if (state.autoScroll && wasAtBottom) {
    activity.scrollTop = activity.scrollHeight;
  }
}

// ----------------------------------------------------------------------
// REST helpers
// ----------------------------------------------------------------------

async function refreshPorts() {
  try {
    const response = await fetch("/api/ports");
    const data = await response.json();
    renderPorts(data.ports || []);
  } catch (error) {
    console.error("refreshPorts failed", error);
  }
}

async function connect() {
  const device = $("portSelect").value;
  const baud = parseInt($("baudInput").value, 10);
  const bytesize = parseInt($("bytesizeInput").value, 10);
  const parity = $("parityInput").value;
  const stopbits = parseFloat($("stopbitsInput").value);

  if (!device) {
    setStatus("select a device", "warning");
    return;
  }

  if (!Number.isFinite(baud) || baud <= 0) {
    setStatus("invalid baud rate", "error");
    return;
  }

  setStatus(`connecting to ${device}…`, "warning");

  try {
    const response = await fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, baud, bytesize, parity, stopbits }),
    });
    const data = await response.json();

    if (!data.ok) {
      setStatus(data.error || "connect failed", "error");
      return;
    }

    state.activeDevice = data.device;
    state.activeBaud = data.baud;
    updateDeviceLabel(data);
  } catch (error) {
    console.error("connect failed", error);
    setStatus("connect failed", "error");
  }
}

function updateDeviceLabel(data) {
  const parityChar =
    data.parity && data.parity !== "none"
      ? data.parity[0].toUpperCase()
      : "N";

  $("activeDeviceLabel").textContent =
    `${data.device} · ${data.baud} · ${data.bytesize || 8}${parityChar}${data.stopbits || 1}`;
}

async function disconnect() {
  try {
    const response = await fetch("/api/disconnect", { method: "POST" });
    const data = await response.json().catch(() => ({}));

    if (data && data.ok === false) {
      setStatus(data.error || "disconnect failed", "error");
      return;
    }

    state.activeDevice = null;
    state.activeBaud = null;
    $("activeDeviceLabel").textContent = "—";
  } catch (error) {
    console.error("disconnect failed", error);
    setStatus("disconnect failed", "error");
  }
}

async function send() {
  const input = $("sendInput");
  const data = input.value;
  if (!data) return;

  const encoding = $("encodingInput").value;
  const newline = $("newlineInput").value;
  const feedback = $("sendFeedback");

  feedback.className = "send-feedback";
  feedback.textContent = "SENDING…";

  try {
    const response = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data, encoding, newline }),
    });
    const payload = await response.json();

    if (payload.ok) {
      saveCommandToHistory(data);
      feedback.className = "send-feedback success";
      feedback.textContent = `SENT ${payload.bytes_sent} BYTE(S)`;
      input.value = "";

      setTimeout(async () => {
        try {
          await fetch("/api/read?timeout_ms=200");
        } catch (_) {
          // Serial responses can still arrive through SocketIO.
        }
      }, 200);
    } else {
      feedback.className = "send-feedback error";
      feedback.textContent = payload.error || "SEND FAILED";
    }
  } catch (_) {
    feedback.className = "send-feedback error";
    feedback.textContent = "NETWORK ERROR";
  }

  setTimeout(() => {
    feedback.textContent = "";
    feedback.className = "send-feedback";
  }, 3000);
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

function exportHistory() {
  if (!state.activeDevice) return;

  const rows = [["timestamp", "iso", "direction", "hex", "text"]];

  document.querySelectorAll("#activity .entry").forEach((entry) => {
    const direction = entry.classList.contains("tx") ? "tx" : "rx";
    const hex = entry.dataset.hex || "";
    const text = (entry.dataset.text || "").replace(/<binary: ([^>]+)>/, "$1");
    const timestamp = Date.now();
    rows.push([timestamp, new Date(timestamp).toISOString(), direction, hex, text]);
  });

  const csv = rows
    .map((row) => row.map((cell) => {
      const value = String(cell ?? "");
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    }).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = `${state.activeDevice.replace(/[^A-Za-z0-9._-]+/g, "_")}-history.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------------
// Sidebar collapse
// ----------------------------------------------------------------------

const SIDEBAR_KEY = "serialPortUI:sidebar";

function setSidebar(collapsed) {
  const sidebar = $("settingsSidebar");
  const toggle = $("sidebarToggleBtn");

  if (collapsed) {
    sidebar.classList.add("is-collapsed");
    toggle.classList.remove("hidden");
  } else {
    sidebar.classList.remove("is-collapsed");
    toggle.classList.add("hidden");
  }

  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch (_) {}
}

function initSidebar() {
  let saved = null;
  try {
    saved = localStorage.getItem(SIDEBAR_KEY);
  } catch (_) {}

  setSidebar(saved === "1");
}

// ----------------------------------------------------------------------
// Wire up
// ----------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initSidebar();

  $("themeToggle").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);

    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (_) {}
  });

  $("sidebarToggleBtn").addEventListener("click", () => {
    const sidebar = $("settingsSidebar");
    setSidebar(!sidebar.classList.contains("is-collapsed"));
  });

  $("sidebarToggle").addEventListener("click", () => setSidebar(true));

  $("refreshBtn").addEventListener("click", refreshPorts);
  $("connectBtn").addEventListener("click", connect);
  $("disconnectBtn").addEventListener("click", disconnect);
  $("sendBtn").addEventListener("click", send);
  $("loadHistoryBtn").addEventListener("click", () => loadHistory(state.activeDevice));
  $("clearHistoryBtn").addEventListener("click", clearHistory);
  $("exportBtn").addEventListener("click", exportHistory);

  $("sendInput").addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      recallCommand("up");
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      recallCommand("down");
      return;
    }

    // Enter sends a command; Shift + Enter keeps the normal textarea newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();

      setTimeout(async () => {
        try {
          await loadHistory(state.activeDevice);
        } catch (_) {}
      }, 400);
    }
  });

  $("showRx").addEventListener("change", applyAllFilters);
  $("showTx").addEventListener("change", applyAllFilters);

  $("autoScroll").addEventListener("change", (event) => {
    state.autoScroll = event.target.checked;
  });

  $("showTime").addEventListener("change", (event) => {
    state.showTime = event.target.checked;
    document
      .querySelectorAll("#activity .entry")
      .forEach((entry) => entry.classList.toggle("time-hidden", !state.showTime));
  });

  $("filterInput").addEventListener("input", (event) => {
    state.filter = event.target.value.trim();
    applyAllFilters();
  });

  $("portSelect").addEventListener("change", (event) => {
    const device = event.target.value;
    if (device && device !== state.historyLoadedFor) {
      loadHistory(device);
    }
  });

  $("flashBtn").addEventListener("click", () => {
    alert(
      "Flash Device is a UI placeholder — wire it to your firmware\n" +
      "flashing endpoint before relying on it."
    );
  });

  socket.on("ports_update", (msg) => renderPorts(msg.ports || []));

  socket.on("serial_status", (msg) => {
    if (msg.state === "connected") {
      state.activeDevice = msg.device;
      state.activeBaud = msg.baud;

      updateDeviceLabel({
        device: msg.device,
        baud: msg.baud,
        bytesize: msg.bytesize,
        parity: msg.parity,
        stopbits: msg.stopbits,
      });

      setStatus(`CONNECTED · ${msg.device}`, "connected");
      setConnectedUI(true);
      loadHistory(msg.device);
    } else if (msg.state === "disconnected") {
      setStatus("DISCONNECTED", "disconnected");
      setConnectedUI(false);
      state.activeDevice = null;
      state.activeBaud = null;
      $("activeDeviceLabel").textContent = "—";
    } else if (msg.state === "error") {
      setStatus(msg.message || "ERROR", "error");
      setConnectedUI(false);
      state.lastError = msg;
    }
  });

  socket.on("serial_data", appendLive);
  refreshPorts();
});
