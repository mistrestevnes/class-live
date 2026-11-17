// Class Live — code shared by the student and teacher pages.

// ---------------------------------------------------------------- connection
// Tries a live WebSocket first. If the school network blocks it, switches to
// checking the server every couple of seconds with ordinary requests.
class Link {
  constructor({ wsUrl, poll, post, onMessage, onMode, pollMs = 2000 }) {
    Object.assign(this, { wsUrl, poll, post, onMessage, onMode, pollMs });
    this.ws = null;
    this.mode = "connecting";
    this.wsFails = 0;
    this.pollTimer = null;
    this.lastProbe = 0;
  }

  start() {
    this.tryWs();
  }

  setMode(m) {
    if (this.mode !== m) {
      this.mode = m;
      this.onMode && this.onMode(m);
    }
  }

  tryWs(probe = false) {
    let ws;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch {
      return this.wsFailed(false, probe);
    }
    let opened = false;
    const timer = setTimeout(() => {
      if (!opened) {
        try { ws.close(); } catch {}
      }
    }, 6000);
    ws.onopen = () => {
      opened = true;
      this.everOpen = true;
      clearTimeout(timer);
      this.ws = ws;
      this.wsFails = 0;
      this.stopPolling();
      this.setMode("live");
      ws._ping = setInterval(() => {
        try { ws.send("ping"); } catch {}
      }, 25000);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      try { this.onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      clearTimeout(timer);
      clearInterval(ws._ping);
      if (this.ws === ws) this.ws = null;
      this.wsFailed(opened, probe);
    };
  }

  wsFailed(wasOpen, probe) {
    if (probe && !wasOpen) return; // a quiet retry while polling didn't work; keep polling
    if (!wasOpen && !this.everOpen) return this.startPolling(); // blocked from the start: poll right away
    this.wsFails++;
    if (this.wsFails >= 3) return this.startPolling();
    this.setMode("connecting");
    setTimeout(() => this.tryWs(), wasOpen ? 1000 : 1500);
  }

  startPolling() {
    this.setMode("polling");
    if (this.polling) return;
    this.polling = true;
    const gen = (this.pollGen = (this.pollGen || 0) + 1);
    this.lastProbe = Date.now();
    const loop = async () => {
      if (gen !== this.pollGen) return;
      try {
        const data = await this.poll();
        if (gen !== this.pollGen) return; // switched to live while waiting
        this.onMessage(data);
        this.setMode("polling");
      } catch {
        if (gen !== this.pollGen) return;
        this.setMode("offline");
      }
      // every 90 seconds, quietly see whether a live connection works now
      if (Date.now() - this.lastProbe > 90000) {
        this.lastProbe = Date.now();
        this.tryWs(true);
      }
      this.pollTimer = setTimeout(loop, document.hidden ? this.pollMs * 2.5 : this.pollMs);
    };
    loop();
  }

  stopPolling() {
    this.polling = false;
    this.pollGen = (this.pollGen || 0) + 1;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  async send(msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    try {
      this.onMessage(await this.post(msg));
    } catch {
      this.setMode("offline");
    }
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, { cache: "no-store", ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Request failed (" + res.status + ")");
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- small helpers
const LETTERS = "ABCDEFGHIJ";

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k in n && k !== "list" && k !== "style") n[k] = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
  return n;
}

function randomId(n = 8) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    if (val === null) localStorage.removeItem(key);
    else localStorage.setItem(key, val);
  } catch {}
  return null;
}

// Text formatting the teacher can type:
//   blank line  -> new paragraph
//   - item      -> bullet list
//   **words**   -> bold
//   *words*     -> italics
//   v_f, v_i    -> subscript after an underscore (letters/numbers)
//   x^2         -> superscript after a caret
function inline(text) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|[A-Za-zΔ]_[A-Za-z0-9]+|\^-?[0-9A-Za-z]+)/g);
  for (const part of parts) {
    if (!part) continue;
    if (/^\*\*\*[^*]+\*\*\*$/.test(part)) frag.append(el("strong", {}, el("em", { text: part.slice(3, -3) })));
    else if (/^\*\*[^*]+\*\*$/.test(part)) frag.append(el("strong", { text: part.slice(2, -2) }));
    else if (/^\*[^*\s][^*]*\*$/.test(part)) frag.append(el("em", { text: part.slice(1, -1) }));
    else if (/^[A-Za-zΔ]_[A-Za-z0-9]+$/.test(part)) frag.append(part[0], el("sub", { text: part.slice(2) }));
    else if (/^\^-?[0-9A-Za-z]+$/.test(part)) frag.append(el("sup", { text: part.slice(1) }));
    else frag.append(part);
  }
  return frag;
}

function formatText(src) {
  const wrap = el("div", { class: "cl-text" });
  const paras = String(src || "").replace(/\r/g, "").split(/\n\s*\n/);
  for (const para of paras) {
    const lines = para.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    let ul = null;
    let p = null;
    for (const line of lines) {
      const bullet = line.match(/^\s*[-•]\s+(.*)$/);
      if (bullet) {
        p = null;
        if (!ul) wrap.append((ul = el("ul")));
        ul.append(el("li", {}, inline(bullet[1])));
      } else {
        ul = null;
        if (!p) wrap.append((p = el("p")));
        else p.append(el("br"));
        p.append(inline(line));
      }
    }
  }
  return wrap;
}

// ---------------------------------------------------------------- freeform pages
// A page is a 1366 x 599 canvas. Every block has x, y, w, h in canvas units and the whole canvas is scaled to fit
// the screen showing it, so text wraps the same way everywhere. Text sizes are canvas units too, which on a Chromebook are real pixels.
// The page is the real Chromebook page area: 1366 x 599 px (units are Chromebook pixels). Older pages were 1600 x 900 (no cv)
// or 1600 x 702 (cv 2); canvasify converts them once.
const CANVAS_W = 1366, CANVAS_H = 599, CANVAS_BG = "#F7F4EE", MIN_FONT = 1, HEAD_SIZE = 55, TEXT_SIZE = 31;
const OLD_W = 1600, OLD_HEAD = 64, OLD_TEXT = 36;
// width, height (and place) a new block starts at: a sim is 1020 x 599 at the left, the question fills the rest on the right
const BLOCK_START = { heading: [1025, 94], text: [854, 239], image: [546, 342], sim: [1020, 599, 0, 0], video: [820, 461], poll: [939, 478], question: [346, 599, 1020, 0] };

const safeColor = (c) => (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c || "") ? c : "");
// dark ink on a light page, white on a dark one
function autoInk(bg) {
  let h = safeColor(bg).slice(1);
  if (!h) return "#12291F";
  if (h.length === 3) h = h.replace(/./g, "$&$&");
  const [r, g, b] = [0, 2, 4].map((i) => { const v = parseInt(h.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.22 ? "#12291F" : "#FFFFFF";
}

function newCanvasPage() {
  return { id: randomId(8), name: "", layout: "canvas", bg: CANVAS_BG, blocks: [
    { type: "heading", text: "", x: 51, y: 30, w: 1264, h: 84, size: HEAD_SIZE, color: "" },
    { type: "text", text: "", x: 51, y: 124, w: 1264, h: 440, size: TEXT_SIZE, color: "" },
  ] };
}

// a rough height for some text, used only when an older stacked page is turned into a canvas page
function textHeight(text, size, width, bold) {
  const perLine = Math.max(6, Math.floor((width - 28) / (size * (bold ? 0.56 : 0.5))));
  let lines = 0, paras = 0;
  for (const para of String(text || "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const ls = para.split("\n").filter((l) => l.trim() !== "");
    if (!ls.length) continue;
    paras++;
    for (const l of ls) lines += Math.max(1, Math.ceil(l.length / perLine));
  }
  return Math.ceil(Math.max(1, lines) * size * (bold ? 1.25 : 1.4) + Math.max(0, paras - 1) * size * 0.7 + 20);
}

// the real height some text takes in a box of this width, measured in the browser (null if there is no page to measure on)
function measureText(b, size, width) {
  if (typeof document === "undefined" || !document.body) return null;
  const head = b.type === "heading";
  const probe = el("div", { class: "cl-canvas", style: "left:-9999px;top:0;visibility:hidden;transform:none;height:auto;width:" + width + "px" },
    el("div", { class: "cl-ctextin" + (head ? " cl-chead" : ""), style: "height:auto;font-size:" + size + "px" }, head ? inline(b.text || "") : formatText(b.text)));
  document.body.append(probe);
  const h = probe.firstChild.offsetHeight;
  probe.remove();
  return h || null;
}

// Turns an older page (blocks stacked top to bottom) into a canvas page, once. Blocks keep their order and
// go where they were, top to bottom; a sim or a full-screen picture on its own fills the whole canvas.
function canvasify(page) {
  if (page.layout === "canvas") {
    // pages made on the older 1600-wide pages get the Chromebook page (1366 x 599): every box keeps its place and shape
    if (page.cv !== 3) {
      const ky = CANVAS_H / (page.cv === 2 ? 702 : 900), kx = CANVAS_W / OLD_W;
      for (const b of page.blocks || []) {
        if (!b) continue;
        b.x = Math.round((b.x || 0) * kx); b.w = Math.max(20, Math.round((b.w || 200) * kx));
        b.y = Math.round((b.y || 0) * ky); b.h = Math.max(17, Math.round((b.h || 100) * ky));
        if (b.size) b.size = Math.max(MIN_FONT, Math.round(b.size * kx));
        if (b.qsize) b.qsize = Math.max(MIN_FONT, Math.round(b.qsize * kx));
      }
      page.cv = 3;
    }
    return page;
  }
  page.cv = 2;
  page.layout = "canvas";
  page.bg = safeColor(page.bg) || CANVAS_BG;
  // blank text boxes were never shown to students, so they don't take a place
  const bs = (page.blocks || []).filter((b) => b && !((b.type === "heading" || b.type === "text") && !(b.text || "").trim()));
  page.blocks = bs;
  const fills = (b) => (b.type === "sim" && (b.height || "tall") === "tall") || (b.type === "image" && b.size === "full");
  if (bs.length === 1 && fills(bs[0])) { Object.assign(bs[0], { x: 0, y: 0, w: OLD_W, h: 702 }); return canvasify(page); }
  const L = 60, W = OLD_W - 2 * L, GAP = 26, TOP = 36, AVAIL = 702 - TOP - 36;
  const plan = (f) => {
    const rows = bs.map((b) => {
      const r = { b, x: L, w: W, h: 0, fill: false, size: 0 };
      if (b.type === "heading") { r.size = Math.max(MIN_FONT, Math.round(OLD_HEAD * f)); r.h = Math.ceil((measureText(b, r.size, W) || textHeight(b.text, r.size, W, true)) * 1.06) + 4; }
      else if (b.type === "text") { r.size = Math.max(MIN_FONT, Math.round(OLD_TEXT * f)); r.h = Math.ceil((measureText(b, r.size, W) || textHeight(b.text, r.size, W, false)) * 1.06) + 4; }
      else if (b.type === "image") {
        if (b.size === "full") r.fill = true;
        else { r.w = Math.round(({ small: 360, medium: 560, large: 840 }[b.size] || 560) * f); r.h = Math.round(r.w * 0.66) + (b.caption ? 50 : 0); r.x = Math.round((OLD_W - r.w) / 2); }
      } else if (b.type === "sim") { if ((b.height || "tall") === "tall") r.fill = true; else r.h = Math.round(440 * f); }
      else if (b.type === "video") { r.w = Math.round(840 * f); r.h = Math.round((r.w * 9) / 16) + (b.caption ? 50 : 0); r.x = Math.round((OLD_W - r.w) / 2); }
      else if (b.type === "poll") { r.w = 1200; r.x = 200; r.h = textHeight(b.question, 36, 1200, false) + (b.options || []).length * 92 + 60; }
      else if (b.type === "question") r.h = 440 + (b.kind === "mc" ? (b.options || []).length * 84 : 0);
      else r.h = 200;
      return r;
    });
    const fixed = rows.reduce((n, r) => n + r.h, 0) + Math.max(0, rows.length - 1) * GAP;
    return { rows, fixed, nFill: rows.filter((r) => r.fill).length };
  };
  let p = plan(1);
  if (p.fixed + p.nFill * 320 > AVAIL) p = plan(Math.max(0.55, AVAIL / (p.fixed + p.nFill * 320)));
  const fillH = p.nFill ? Math.max(300, Math.floor((AVAIL - p.fixed) / p.nFill)) : 0;
  let y = TOP;
  for (const r of p.rows) {
    if (r.fill) { r.h = fillH; r.x = 30; r.w = OLD_W - 60; }
    Object.assign(r.b, { x: r.x, y, w: r.w, h: r.h });
    if (r.size) { r.b.size = r.size; r.b.color = r.b.color || ""; }
    y += r.h + GAP;
  }
  return canvasify(page);
}

const blockBox = (b) => "left:" + Math.round(b.x || 0) + "px;top:" + Math.round(b.y || 0) + "px;width:" + Math.round(b.w || 200) + "px;height:" + Math.round(b.h || 100) + "px";
function textStyle(b) {
  const c = safeColor(b.color);
  return "font-size:" + Math.max(MIN_FONT, b.size || (b.type === "heading" ? HEAD_SIZE : TEXT_SIZE)) + "px" + (c ? ";color:" + c : "");
}

// question text formatting: size (px on the 1366-wide canvas), bold, italic
const QSIZE = 22;
function qFormat(b) { return { size: Math.max(MIN_FONT, Number(b && b.qsize) || QSIZE), bold: !!(b && b.qbold), italic: !!(b && b.qital) }; }
function applyQFormat(box, b) {
  const f = qFormat(b);
  if (b && b.qsize) box.style.setProperty("--qfs", f.size + "px"); else box.style.removeProperty("--qfs");
  box.classList.toggle("qb", f.bold); box.classList.toggle("qi", f.italic);
}
function clockText(sec) { return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); }
// the box a question block shows in the builder and the Control room: the same box a student gets when it is open
function questionCard(b, qn) {
  const mc = b.kind === "mc" ? (b.options || []).filter((o) => String(o).trim()) : [];
  const box = el("section", { class: "aero-panel cl-cover-box cl-inline cl-qcard" },
        el("div", { class: "cl-ask-prompt" }, formatText(b.prompt || "(No question typed yet)")),
    mc.length ? el("div", { class: "cl-options" }, ...mc.map((o, i) => el("div", { class: "cl-option" }, el("span", { class: "cl-letter", text: LETTERS[i] }), el("span", {}, inline(o)))))
      : el("textarea", { rows: 6, "aria-label": "Your answer", disabled: true }),
    el("div", { class: "cl-ask-foot" }, el("span", { class: "aero-muted" }), mc.length ? null : el("button", { class: "aero-btn-primary", text: "Submit", disabled: true })));
  applyQFormat(box, b);
  return box;
}

// What goes inside a block's box (null: nothing to show students).
// opts.edit = { simName(url), videoName(id) } makes sims and videos plain labelled boxes, for the builder.
function blockInner(b, opts = {}) {
  const ph = (kind, text) => [el("div", { class: "cl-ph" }, el("div", { class: "cl-ph-kind", text: kind }), el("div", { text }))];
  if (b.type === "heading" || b.type === "text") {
    if (!(b.text || "").trim()) return null; // blank boxes aren't shown
    const head = b.type === "heading";
    return [el("div", { class: "cl-ctextin" + (head ? " cl-chead" : ""), style: textStyle(b) }, head ? inline(b.text) : formatText(b.text))];
  }
  if (b.type === "image") {
    if (!b.imageId) return opts.edit ? ph("Picture", "Choose a picture in the window on the right") : null;
    return [el("figure", { class: "cl-figure" + (b.fit === "fill" ? " fit-fill" : "") }, el("img", { src: "/img/" + b.imageId, alt: b.caption || "" }), b.caption ? el("figcaption", {}, inline(b.caption)) : null)];
  }
  if (b.type === "sim") {
    const ok = /^(https:\/\/|\/sim\/[a-z0-9]+$)/.test(b.url || "");
    if (opts.edit && opts.edit.simPreview && ok) { const f = el("iframe", { src: b.url, title: "Simulation", allow: "autoplay", tabindex: "-1" }); f._clBlock = b; return [el("div", { class: "cl-sim aero-stage" }, f)]; }
    if (opts.edit) return ph("Sim", ok ? (opts.edit.simName ? opts.edit.simName(b.url) : b.url) : "Choose a sim in the window on the right");
    if (!ok) return null;
    const f = el("iframe", { src: b.url, title: "Simulation", allow: "fullscreen; autoplay", allowfullscreen: true, loading: "lazy" });
    f._clBlock = b;
    return [el("div", { class: "cl-sim aero-stage" }, f)];
  }
  if (b.type === "video") {
    const ok = /^[a-z0-9]{6,24}$/.test(b.videoId || "");
    if (opts.edit) return ph("Video", ok ? (opts.edit.videoName ? opts.edit.videoName(b.videoId) : "Video chosen") : "Choose a video in the window on the right");
    if (!ok) return null;
    return [el("figure", { class: "cl-figure cl-video" },
      el("video", { src: "/video/" + b.videoId, controls: true, controlsList: "nodownload", disablePictureInPicture: true, playsinline: true, preload: "metadata", "data-video-id": b.videoId }),
      b.caption ? el("figcaption", {}, inline(b.caption)) : null)];
  }
  if (b.type === "poll") return [renderPoll(b, opts)];
  if (b.type === "question") return opts.edit ? [questionCard(b, opts.qn)] : null;
  return null;
}
// ---- page states: a page can have several, the teacher moves the class from one to the next.
// page.states = [{id, name}] (none: one state). A block's states (list of ids) says where it shows (none: all of them);
// a sim's lock (list of ids) says where it is locked.
function pageStates(page) { return Array.isArray(page.states) && page.states.length ? page.states : [{ id: "s1", name: "State 1" }]; }
function stateOfPage(page, wanted) { const st = pageStates(page); return st.some((x) => x.id === wanted) ? wanted : st[0].id; }
function blockShowsIn(b, sid) { return !Array.isArray(b.states) || !b.states.length || b.states.includes(sid); }
function blockLockedIn(b, sid) { return Array.isArray(b.lock) && b.lock.includes(sid); }
const stateAttrs = (b) => ({ "data-bs": Array.isArray(b.states) ? b.states.join(",") : "", "data-lk": Array.isArray(b.lock) ? b.lock.join(",") : "" });
// Tells each sim on the page which state the page is in: {classlive:"state", state:"closeup"} when the sim has
// a setting for this state (b.simStates[stateId]), otherwise {classlive:"state", n: position from 1}.
// Sent when the state changes, every time the sim finishes loading, and when the sim asks with {classlive:"getState"}.
const simOverride = new WeakMap(); // builder only: a state picked with the "Sim shows" buttons, kept until the page state changes
function simStateMsg(page, b, sid) {
  if (b && simOverride.has(b)) return simOverride.get(b);
  const word = b && b.simStates && String(b.simStates[sid] || "").trim();
  if (word) return { classlive: "state", state: word };
  return { classlive: "state", n: Math.max(1, pageStates(page).findIndex((x) => x.id === sid) + 1) };
}
function postSimState(f) { try { f.contentWindow.postMessage(f._clMsg, "*"); f._clSent = JSON.stringify(f._clMsg); } catch {} }
function syncSimStates(root, page, sid) {
  for (const f of root.querySelectorAll(".cl-sim iframe")) {
    if (!f._clBlock) continue;
    f._clMsg = simStateMsg(page, f._clBlock, sid);
    if (!f._clHooked) { f._clHooked = true; f.addEventListener("load", () => { f._clLoaded = true; postSimState(f); }); }
    if (f._clLoaded && f._clSent !== JSON.stringify(f._clMsg)) postSimState(f);
  }
}
window.addEventListener("message", (e) => {
  if (!e.data || e.data.classlive !== "getState") return;
  for (const f of document.querySelectorAll(".cl-sim iframe")) if (f.contentWindow === e.source && f._clMsg) postSimState(f);
});
// shows the blocks of the chosen state and locks the sims, right in the page (nothing reloads)
function applyStates(root, sid) {
  for (const n of root.querySelectorAll(".cl-cblock")) {
    const bs = n.dataset.bs, lk = n.dataset.lk;
    n.classList.toggle("cl-nostate", !!bs && !bs.split(",").includes(sid));
    const locked = !!lk && lk.split(",").includes(sid);
    n.classList.toggle("cl-locked", locked);
    if (locked) n.setAttribute("inert", ""); else n.removeAttribute("inert");
  }
}
const BLOCK_CLASS = { heading: "cl-ctext", text: "cl-ctext", image: "cl-cimg", sim: "cl-csim", video: "cl-cvid", poll: "cl-cpoll", question: "cl-cq" };

// a question box reaching the bottom of the page: its Submit sits above the floating Back / Next buttons
const qLow = (b) => ((b.y || 0) + (b.h || 0) >= CANVAS_H - 12 ? " cl-qlow" : "");
const geo = (b) => [b.x || 0, b.y || 0, b.w || 200, b.h || 100].map((v) => Math.round(v)).join(",");
function renderBlock(b, opts = {}) {
  const box = blockBox(b);
  // a question block stays hidden until the teacher opens it; the question then appears right in this box
  if (b.type === "question" && !opts.preview) return el("div", { class: "cl-cblock cl-qblock" + qLow(b), "data-id": b.id || "", ...stateAttrs(b), "data-g": geo(b), hidden: true, style: box });
  const inner = b.type === "question" ? [questionCard(b, opts.qn)] : blockInner(b, opts.preview ? { ...opts, edit: opts.edit || {} } : opts);
  if (!inner) return null;
  return el("div", { class: "cl-cblock " + (BLOCK_CLASS[b.type] || "") + (b.type === "question" ? " cl-qblock" + qLow(b) : ""), ...stateAttrs(b), "data-g": geo(b), style: box }, inner);
}

// opts: { myChoice, closed, onVote(choice), results: {counts,total}, preview }
// Returns the page as a box that keeps its 16:9 shape. Mount it with mountPage (or fitCanvasBox) so it scales to fit.
function renderPage(page, opts = {}) {
  canvasify(page);
  const bg = safeColor(page.bg) || CANVAS_BG;
  const canvas = el("div", { class: "cl-canvas", style: "background:" + bg + ";color:" + autoInk(bg) });
  let qn = 0;
  for (const b of page.blocks || []) { const n = renderBlock(b, b.type === "question" ? { ...opts, qn: ++qn } : opts); if (n) canvas.append(n); }
  return el("div", { class: "cl-canvas-fit" + (opts.stretch ? " cl-stretch" : "") }, canvas);
}

// Makes a canvas box the biggest 16:9 that fits inside parent, and tells it how much it is scaled (--s).
// Returns the observer, so a caller that replaces the box can disconnect it.
function fitCanvasBox(fit, parent) {
  let ro = null;
  const go = () => {
    if (!fit.isConnected && ro) { ro.disconnect(); return; }
    const cs = getComputedStyle(parent);
    const w = parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = parent.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const s = Math.max(0.1, Math.min(w / CANVAS_W, h / CANVAS_H));
    const extra = +fit.dataset.extra || 0; // a question box that grew past the bottom makes the page taller
    if (fit.classList.contains("cl-stretch")) {
      // the page fills the whole space: each box keeps its place against the edges and grows with the page;
      // nothing inside is stretched (text keeps its size, pictures and sims keep their shape)
      const cw = w / s, ch = h / s, kx = cw / CANVAS_W, ky = ch / CANVAS_H;
      fit.style.width = Math.floor(w) + "px";
      fit.style.height = Math.floor((ch + extra) * s) + "px";
      fit.dataset.ch = String(ch);
      const cv = fit.querySelector(".cl-canvas");
      if (cv) { cv.style.width = cw + "px"; cv.style.height = (ch + extra) + "px"; }
      for (const n of fit.querySelectorAll(".cl-cblock[data-g]")) {
        const [x, y, bw, bh] = n.dataset.g.split(",").map(Number);
        n.style.left = x * kx + "px"; n.style.top = y * ky + "px"; n.style.width = bw * kx + "px";
        const h0 = bh * ky;
        if (n.classList.contains("cl-qblock")) { n.dataset.h0 = String(h0); n.style.height = Math.max(parseFloat(n.style.height) || 0, h0) + "px"; }
        else n.style.height = h0 + "px";
      }
      fit.style.setProperty("--s", String(s));
      fit.style.setProperty("--is", String(1 / s));
      return;
    }
    fit.style.width = Math.floor(CANVAS_W * s) + "px";
    fit.style.height = Math.floor((CANVAS_H + extra) * s) + "px";
    const cv = fit.querySelector(".cl-canvas");
    if (cv) cv.style.height = extra ? (CANVAS_H + extra) + "px" : "";
    fit.style.setProperty("--s", String(s));
    fit.style.setProperty("--is", String(1 / s));
  };
  fit._fit = go;
  ro = new ResizeObserver(go);
  ro.observe(parent);
  go();
  return ro;
}

// A button under a sim or image that shows it on the whole screen. Esc comes back.
function fullscreenButton(target) {
  const go = target.requestFullscreen || target.webkitRequestFullscreen;
  if (!go) return null;
  return el("div", { class: "cl-fs-row" },
    el("button", { class: "cl-fs-btn", text: "⛶ Fullscreen", onclick: () => { try { go.call(target); } catch {} } }));
}

// Puts a page into a container without reloading sims or images when only
// the poll changed (a vote, results shown, etc.).
function mountPage(container, page, opts = {}, decoratePoll) {
  canvasify(page);
  const key = JSON.stringify(page);
  if (container._key !== key) {
    container._key = key;
    const fit = renderPage(page, opts);
    container.replaceChildren(fit);
    if (container._ro) container._ro.disconnect();
    container._ro = fitCanvasBox(fit, container);
  }
  applyStates(container, stateOfPage(page, opts.stateId));
  syncSimStates(container, page, stateOfPage(page, opts.stateId));
  const old = container.querySelector(".cl-poll");
  const b = (page.blocks || []).find((x) => x.type === "poll");
  if (old && b) {
    const fresh = renderPoll(b, opts);
    if (decoratePoll) decoratePoll(fresh);
    old.replaceWith(fresh);
  }
}

function renderPoll(b, opts) {
  const box = el("div", { class: "cl-poll" });
  if (b.question) box.append(el("div", { class: "cl-question" }, formatText(b.question)));
  const options = b.options || [];
  const res = opts.results;
  const list = el("div", { class: "cl-options" });
  options.forEach((text, i) => {
    if (res) {
      const n = res.counts[i] || 0;
      const pct = res.total ? Math.round((100 * n) / res.total) : 0;
      list.append(
        el(
          "div",
          { class: "cl-result" },
          el("span", { class: "cl-letter", text: LETTERS[i] }),
          el(
            "div",
            { class: "cl-result-main" },
            el("div", { class: "cl-result-text" }, inline(text)),
            el("div", { class: "cl-bar-track" }, el("div", { class: "cl-bar", style: "width:" + pct + "%" }))
          ),
          el("span", { class: "cl-result-num aero-data", text: n + " · " + pct + "%" })
        )
      );
    } else {
      list.append(
        el(
          "button",
          {
            class: "cl-option",
            "aria-pressed": opts.myChoice === i ? "true" : "false",
            disabled: !!opts.closed || !opts.onVote,
            onclick: () => opts.onVote && opts.onVote(i),
          },
          el("span", { class: "cl-letter", text: LETTERS[i] }),
          el("span", { class: "cl-option-text" }, inline(text))
        )
      );
    }
  });
  box.append(list);
  return box;
}
