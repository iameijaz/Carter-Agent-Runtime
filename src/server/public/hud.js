// HUD controller — a chat transcript over one WebSocket, plus the operator
// approval overlay. The overlay is the point: `requestApproval()` on the server
// blocks a tool (e.g. install_mcp_server) until a decision arrives here, and
// fails closed with no client attached.

import { renderMarkdownInto, esc } from "./markdown.js";

export class Hud {
  constructor(dom) {
    this.dom = dom;
    this.running = false;
    this.pendingHilId = null;
    this.streamEl = null; // <div> the current assistant answer streams into
    this.tools = new Map(); // tool call id -> its rail row, awaiting a finish

    this.sessionId = localStorage.getItem("carter-session");
    if (!this.sessionId) {
      this.sessionId = crypto.randomUUID();
      localStorage.setItem("carter-session", this.sessionId);
    }
  }

  init() {
    this._wireDom();
    this._clock();
    setInterval(() => this._clock(), 1000);
    this.connect();
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/?session=${this.sessionId}`);
    this.ws = ws;
    ws.addEventListener("open", () => this._net(true));
    ws.addEventListener("message", (e) => { try { this.route(JSON.parse(e.data)); } catch { /* bad frame */ } });
    ws.addEventListener("close", () => { this._net(false); setTimeout(() => this.connect(), 1200); });
    ws.addEventListener("error", () => ws.close());
  }

  wsSend(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  route(ev) {
    switch (ev.type) {
      case "history":
        this.dom.transcript.replaceChildren();
        for (const m of ev.messages || []) this._addMessage(m.role, m.text);
        // The rail tracks the live run, and history has no tool calls in it —
        // leaving old rows up would attribute them to the replayed turns.
        this.dom.toolList.replaceChildren();
        this.dom.toolCount.textContent = "";
        this.dom.toolEmpty.classList.remove("hidden");
        this.tools.clear();
        break;
      case "model_selected": this._setModel(ev.brain, ev); break;
      case "model_fallback": this._setModel(ev.to, ev); break;
      case "run_started":
        this._setRunning(true);
        this.streamEl = this._addMessage("assistant", "");
        break;
      case "token":
        // Raw text while streaming; re-rendered as markdown when the turn ends.
        if (this.streamEl) this.streamEl.textContent += ev.text;
        break;
      case "tool_call_started": this._toolStart(ev); break;
      case "tool_call_finished": this._toolFinish(ev); break;
      case "assistant_message":
        if (this.streamEl) { renderMarkdownInto(this.streamEl, ev.text); this.streamEl = null; }
        else this._addMessage("assistant", ev.text);
        this._setRunning(false);
        break;
      case "run_cancelled": this._setRunning(false); this.streamEl = null; break;
      case "error":
        this._addNote(`✕ ${ev.message}`, "err");
        this._setRunning(false); this.streamEl = null;
        break;
      case "hil_intercept": this._showHil(ev); break;
      case "bg_task_update": this._addNote(`⟳ ${ev.goal}: ${ev.status} — ${ev.message}`); break;
    }
  }

  // ── transcript ────────────────────────────────────────────────────────────
  _addMessage(role, text) {
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    if (text) renderMarkdownInto(el, text);
    this.dom.transcript.append(el);
    this._scroll();
    return el;
  }

  _addNote(text, cls = "") {
    const el = document.createElement("div");
    el.className = `note ${cls}`;
    el.textContent = text;
    this.dom.transcript.append(el);
    this._scroll();
  }

  _scroll() { this.dom.transcript.scrollTop = this.dom.transcript.scrollHeight; }

  // ── tool rail ─────────────────────────────────────────────────────────────
  // Tool calls render beside the conversation, not inside it. They are a
  // machine trace the operator scans while the answer streams; interleaving
  // them with prose pushed the actual answer off screen.
  _toolStart(ev) {
    const el = document.createElement("div");
    el.className = "tool run";
    el.dataset.started = String(performance.now());
    el.innerHTML =
      `<div class="tool-head"><span class="tool-name"></span><span class="tool-ms">running…</span></div>` +
      `<div class="tool-args"></div>`;
    el.querySelector(".tool-name").textContent = ev.name;
    el.querySelector(".tool-args").textContent = this._brief(ev.args);
    this.tools.set(ev.id, el);
    this.dom.toolList.append(el);
    this.dom.toolEmpty.classList.add("hidden");
    this.dom.toolCount.textContent = `· ${this.dom.toolList.childElementCount}`;
    this.dom.toolrail.scrollTop = this.dom.toolrail.scrollHeight;
  }

  _toolFinish(ev) {
    // A finish with no matching start (reconnect mid-run) still gets a row —
    // silently dropping it would hide exactly the failure worth seeing.
    let el = this.tools.get(ev.id);
    if (!el) { this._toolStart({ id: ev.id, name: ev.name, args: {} }); el = this.tools.get(ev.id); }
    this.tools.delete(ev.id);
    el.className = `tool ${ev.ok ? "ok" : "err"}`;
    const ms = Math.round(performance.now() - Number(el.dataset.started));
    el.querySelector(".tool-ms").textContent = `${ev.ok ? "✓" : "✕"} ${ms} ms`;
    const res = document.createElement("div");
    res.className = "tool-res";
    res.textContent = ev.resultPreview;
    el.append(res);
    this.dom.toolrail.scrollTop = this.dom.toolrail.scrollHeight;
  }

  /** One short line of arguments — the rail is a glance, not a debugger. */
  _brief(args) {
    try {
      const s = JSON.stringify(args);
      return s === "{}" ? "" : s.length > 160 ? s.slice(0, 160) + "…" : s;
    } catch { return ""; }
  }

  // ── status ────────────────────────────────────────────────────────────────
  _net(on) {
    this.dom.liveDot.classList.toggle("online", on);
    this.dom.liveDot.textContent = on ? "● LIVE" : "● OFFLINE";
  }
  /** Model + where it ran. The router label ("gpt") is not the provider: the
   *  same label serves OpenRouter, OpenAI or a local endpoint depending on env,
   *  and the operator needs to know which one their turn just went to. */
  _setModel(m, ev = {}) {
    this.dom.modelName.textContent = (ev.model || m || "").toUpperCase() || "STANDBY";
    this.dom.modelName.title = ev.model ? `${ev.model} via ${ev.via}` : "";
    const local = ev.via === "local";
    this.dom.modelVia.textContent = ev.via ? (local ? "LOCAL" : ev.via.toUpperCase()) : "";
    this.dom.modelVia.classList.toggle("local", local);
  }
  _setRunning(on) {
    this.running = on;
    this.dom.stop.hidden = !on;
    this.dom.send.hidden = on;
    this.dom.scanBar.classList.toggle("active", on);
  }
  _clock() { this.dom.clock.textContent = new Date().toTimeString().slice(0, 8); }

  // ── input ─────────────────────────────────────────────────────────────────
  submit(text) {
    text = (text || "").trim();
    if (!text || !this.ws || this.ws.readyState !== 1) return;
    this._addMessage("user", text);
    this.wsSend({ type: "user_message", text });
    this._setRunning(true);
  }
  cancel() { this.wsSend({ type: "cancel" }); this._setRunning(false); }

  // ── HIL approval ──────────────────────────────────────────────────────────
  _showHil(ev) {
    this.pendingHilId = ev.id;
    this.dom.hilReason.textContent = ev.reason || "Approve this action.";
    this.dom.hilCode.value = ev.code || "";
    this.dom.hil.classList.add("show");
  }
  _resolveHil(approved) {
    if (!this.pendingHilId) return;
    this.wsSend({ type: "hil_response", id: this.pendingHilId, approved, editedCode: this.dom.hilCode.value });
    this.pendingHilId = null;
    this.dom.hil.classList.remove("show");
  }

  _wireDom() {
    const d = this.dom;
    const send = () => { this.submit(d.input.value); d.input.value = ""; };
    d.send.addEventListener("click", send);
    d.stop.addEventListener("click", () => this.cancel());
    d.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    d.hilApprove.addEventListener("click", () => this._resolveHil(true));
    d.hilAbort.addEventListener("click", () => this._resolveHil(false));
    // Escape denies rather than dismissing: a pending approval must not be
    // left hanging until the server's 5-minute timeout closes it.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.pendingHilId) this._resolveHil(false);
    });
  }
}

export { esc };
