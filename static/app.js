/* serialPortUI - front-end logic.
 *
 * Talks to the Flask + SocketIO back-end:
 *  - REST endpoints /api/ports, /api/connect, /api/disconnect,
 *    /api/send, /api/history, /api/clear
 *  - SocketIO events: ports_update, serial_status, serial_data
 *
 * UI structure (matches templates/index.html):
 *   .topbar                 - sticky app bar with brand + Connect button
 *   .console-area           - main flex column: head, toolbar, console frame,
 *                             send row
 *   #activity / .entry      - log output (one .entry per rx/tx line)
 *   .sidebar                - right rail with all connection settings + status
 *   #statusPill             - connection status LED
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
  try { saved = localStorage.getItem(THEME_KEY); } catch (_) {}
  if (saved !== "light" && saved !== "dark") {
    saved = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark" : "light";
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

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlight(text, query) {
  if (!query) return escapeHtml(text);
  const lower = text.toLowerCase();
  const ql = query.toLowerCase();
  const idx = lower.indexOf(ql);
  if (idx < 0) return escapeHtml(text);
  const before = text.slice(0, idx);
  const hit = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return (
    escapeHtml(before) +
    `<span class="hit">${escapeHtml(hit)}</span>` +
    escapeHtml(after)
  );
}

function formatEntry(msg) {
  const tag = msg.direction === "tx" ? "TX" : "RX";
  const isGroup = Array.isArray(msg.lines) && msg.lines.length > 0;
  const text = msg.data_text || "";
  const isBinary = text.startsWith("<binary");
  const body = !isBinary && text.length ? text : msg.data_hex;

  const dir = document.createElement("div");
  dir.className = "entry " + msg.direction + (isGroup ? " group" : "");
  dir.dataset.text = body;
  dir.dataset.hex = msg.data_hex;

  const html =
    `<span class="meta">${fmtTime(msg.timestamp)}</span>` +
    `<span class="tag">${tag}${isGroup ? ` · ${msg.lines.length}` : ""}</span>` +
    `<span class="data"></span>`;
  dir.innerHTML = html;

  const dataEl = dir.querySelector(".data");
  if (isGroup) {
    // Multi-line response: render as a preformatted block so internal
    // newlines survive highlight()/escapeHtml().
    dataEl.classList.add("group-block");
    const highlighted = msg.lines
      .map((ln) => {
        if (state.filter) {
          return highlight(ln, state.filter);
        }
        return escapeHtml(ln);
      })
      .join("<br>");
    dataEl.innerHTML = highlighted;
  } else {
    dataEl.innerHTML = highlight(body, state.filter);
  }

  if (!state.showTime) dir.classList.add("time-hidden");
  applyFiltersToEntry(dir);
  return dir;
}

function applyFiltersToEntry(entry) {
  const isRx = entry.classList.contains("rx");
  const isTx = entry.classList.contains("tx");
  if (isRx && !$("showRx").checked) entry.classList.add("hidden");
  else if (isTx && !$("showTx").checked) entry.classList.add("hidden");
  else if (state.filter) {
    const haystack =
      (entry.dataset.text || "") + " " + (entry.dataset.hex || "");
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
  const sel = $("portSelect");
  const prev = sel.value;
  sel.innerHTML = "";

  if (!ports.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no devices found)";
    sel.appendChild(opt);
    $("portMeta").textContent = "0 devices detected.";
  } else {
    ports.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.device;
      const desc = p.description ? ` — ${p.description}` : "";
      opt.textContent = `${p.device}${desc}`;
      opt.title = [
        p.description, p.manufacturer,
        p.vid ? `VID ${p.vid.toString(16).toUpperCase()}` : null,
        p.pid ? `PID ${p.pid.toString(16).toUpperCase()}` : null,
        p.serial_number,
      ].filter(Boolean).join(" · ");
      sel.appendChild(opt);
    });
    if (prev && ports.some((p) => p.device === prev)) {
      sel.value = prev;
    } else if (
      state.activeDevice &&
      ports.some((p) => p.device === state.activeDevice)
    ) {
      sel.value = state.activeDevice;
    }
    $("portMeta").textContent =
      `${ports.length} device(s) detected · last polled ` +
      new Date().toLocaleTimeString();
  }
}

// ----------------------------------------------------------------------
// History
// ----------------------------------------------------------------------

async function loadHistory(device) {
  if (!device) return;
  const activity = $("activity");
  activity.innerHTML = '<div class="empty">Loading history…</div>';
  try {
    const res = await fetch(
      `/api/history?device=${encodeURIComponent(device)}&limit=500`
    );
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
    activity.innerHTML =
      '<div class="empty">No history yet for this device.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  messages.forEach((m) => frag.appendChild(formatEntry(m)));
  activity.appendChild(frag);
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
  const res = await fetch("/api/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device, baud, bytesize, parity, stopbits }),
  });
  const data = await res.json();
  if (!data.ok) {
    setStatus(data.error || "connect failed", "error");
    return;
  }
  state.activeDevice = data.device;
  state.activeBaud = data.baud;
  updateDeviceLabel(data);
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
  const res = await fetch("/api/disconnect", { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (data && data.ok === false) {
    setStatus(data.error || "disconnect failed", "error");
    return;
  }
  state.activeDevice = null;
  state.activeBaud = null;
  $("activeDeviceLabel").textContent = "—";
}

async function send() {
  const data = $("sendInput").value;
  if (!data) return;
  const encoding = $("encodingInput").value;
  const newline = $("newlineInput").value;
  const fb = $("sendFeedback");
  fb.className = "send-feedback";
  fb.textContent = "SENDING…";
  try {
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data, encoding, newline }),
    });
    const payload = await res.json();
    if (payload.ok) {
      fb.className = "send-feedback success";
      fb.textContent = `SENT ${payload.bytes_sent} BYTE(S)`;
      $("sendInput").value = "";
      // Auto-read: wait 200ms then poll the port for a response
      setTimeout(async () => {
        try {
          await fetch("/api/read?timeout_ms=200");
        } catch (_) {
          // Silently ignore read errors; responses arrive via SocketIO anyway
        }
      }, 200);
    } else {
      fb.className = "send-feedback error";
      fb.textContent = payload.error || "SEND FAILED";
    }
  } catch (e) {
    fb.className = "send-feedback error";
    fb.textContent = "NETWORK ERROR";
  }
  setTimeout(() => { fb.textContent = ""; fb.className = "send-feedback"; }, 3000);
}

async function clearHistory() {
  if (!state.activeDevice) return;
  if (!confirm(`Clear history for ${state.activeDevice}?`)) return;
  await fetch("/api/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device: state.activeDevice }),
  });
  $("activity").innerHTML =
    '<div class="empty">No history yet for this device.</div>';
}

function exportHistory() {
  if (!state.activeDevice) return;
  const rows = [["timestamp", "iso", "direction", "hex", "text"]];
  document.querySelectorAll("#activity .entry").forEach((e) => {
    const dir = e.classList.contains("tx") ? "tx" : "rx";
    const hex = e.dataset.hex || "";
    const text = (e.dataset.text || "").replace(/<binary: ([^>]+)>/, "$1");
    const ts = Date.now();  // best effort, raw epoch not kept on entry
    rows.push([ts, new Date(ts).toISOString(), dir, hex, text]);
  });
  const csv = rows
    .map((r) => r.map((c) => {
      const s = String(c ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.activeDevice.replace(/[^A-Za-z0-9._-]+/g, "_")}-history.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------------
// Sidebar collapse
// ----------------------------------------------------------------------

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
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch (_) {}
}

const SIDEBAR_KEY = "serialPortUI:sidebar";
function initSidebar() {
  let saved = null;
  try { saved = localStorage.getItem(SIDEBAR_KEY); } catch (_) {}
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
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
  });

  $("sidebarToggle").addEventListener("click", () => setSidebar(true));
  $("sidebarToggleBtn").addEventListener("click", () => setSidebar(false));

  $("refreshBtn").addEventListener("click", refreshPorts);
  $("connectBtn").addEventListener("click", connect);
  $("disconnectBtn").addEventListener("click", disconnect);
  $("sendBtn").addEventListener("click", send);
  $("loadHistoryBtn").addEventListener("click", () => loadHistory(state.activeDevice));
  $("clearHistoryBtn").addEventListener("click", clearHistory);
  $("exportBtn").addEventListener("click", exportHistory);

  $("sendInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    }
  });

  $("showRx").addEventListener("change", applyAllFilters);
  $("showTx").addEventListener("change", applyAllFilters);
  $("autoScroll").addEventListener("change", (e) => {
    state.autoScroll = e.target.checked;
  });
  $("showTime").addEventListener("change", (e) => {
    state.showTime = e.target.checked;
    document
      .querySelectorAll("#activity .entry")
      .forEach((n) => n.classList.toggle("time-hidden", !state.showTime));
  });

  $("filterInput").addEventListener("input", (e) => {
    state.filter = e.target.value.trim();
    applyAllFilters();
  });

  $("portSelect").addEventListener("change", (e) => {
    const newDevice = e.target.value;
    if (newDevice && newDevice !== state.historyLoadedFor) {
      loadHistory(newDevice);
    }
  });

  // Flash Device button is decorative; show a hint that it isn't wired
  // to a backend endpoint yet.
  $("flashBtn").addEventListener("click", () => {
    alert(
      "Flash Device is a UI placeholder — wire it to your firmware\n" +
      "flashing endpoint before relying on it."
    );
  });

  // SocketIO bindings
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

  // Initial populate
  refreshPorts();
});
