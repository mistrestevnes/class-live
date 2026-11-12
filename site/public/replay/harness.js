// Class Live replay harness. Goes in as the first script of a sim, both while recording and while playing back.
// It gives the sim an even clock (60 steps a second, driven from outside), fixed random numbers and fresh storage,
// so the same actions on the same steps make the sim do exactly the same thing again.
(function () {
  "use strict";
  const C = window.__RC || { seed: 1, epoch: 1767225600000 };
  const W = window;
  // ---- random numbers: the same sequence every time
  let rs = C.seed >>> 0;
  Math.random = function () {
    rs = (rs + 0x6D2B79F5) >>> 0;
    let t = rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // ---- clock
  const STEP = 1000 / 60;
  let frame = 0, now = 0;
  performance.now = () => now;
  const RealDate = Date;
  function VDate(...a) {
    if (!new.target) return new RealDate(C.epoch + now).toString();
    return a.length ? new RealDate(...a) : new RealDate(C.epoch + now);
  }
  VDate.prototype = RealDate.prototype;
  VDate.now = () => C.epoch + now;
  VDate.parse = RealDate.parse; VDate.UTC = RealDate.UTC;
  W.Date = VDate;
  // ---- animation frames and timers run on that clock
  let rafs = new Map(), rafId = 0;
  W.requestAnimationFrame = (cb) => { const id = ++rafId; rafs.set(id, cb); return id; };
  W.cancelAnimationFrame = (id) => { rafs.delete(id); };
  const timers = new Map(); let tid = 0;
  W.setTimeout = (cb, ms, ...args) => { const id = ++tid; timers.set(id, { at: now + Math.max(0, +ms || 0), cb, args, every: 0 }); return id; };
  W.setInterval = (cb, ms, ...args) => { const e = Math.max(1, +ms || 0); const id = ++tid; timers.set(id, { at: now + e, cb, args, every: e }); return id; };
  W.clearTimeout = W.clearInterval = (id) => { timers.delete(id); };
  W.requestIdleCallback = (cb) => W.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 10 }), 1);
  W.cancelIdleCallback = W.clearTimeout;
  function runTimers() {
    const cutoff = tid; // timers made while these run wait for the next step
    for (let n = 0; n < 10000; n++) {
      let best = null, bid = 0;
      for (const [id, t] of timers) if (id <= cutoff && t.at <= now && (!best || t.at < best.at || (t.at === best.at && id < bid))) { best = t; bid = id; }
      if (!best) break;
      if (best.every) best.at += best.every; else timers.delete(bid);
      try { typeof best.cb === "function" ? best.cb(...best.args) : (0, eval)(String(best.cb)); } catch (e) { console.error(e); }
    }
  }
  // ---- fresh storage each time
  function memStore() {
    const m = new Map();
    return { getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => { m.set(String(k), String(v)); },
      removeItem: (k) => { m.delete(String(k)); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  }
  try { Object.defineProperty(W, "localStorage", { value: memStore(), configurable: true }); } catch (e) {}
  try { Object.defineProperty(W, "sessionStorage", { value: memStore(), configurable: true }); } catch (e) {}
  // ---- pointer capture can't take a made-up pointer, so don't let that stop the sim
  for (const k of ["setPointerCapture", "releasePointerCapture"]) {
    const f = Element.prototype[k];
    Element.prototype[k] = function (id) { try { return f.call(this, id); } catch (e) {} };
  }
  // ---- recording what the teacher does
  let log = null, answers = [];
  const realConfirm = W.confirm.bind(W), realPrompt = W.prompt.bind(W);
  W.confirm = (m) => {
    if (log) { const v = realConfirm(m); log.push({ f: frame, k: "ans", v }); return v; }
    return answers.length ? !!answers.shift() : true;
  };
  W.prompt = (m, d) => {
    if (log) { const v = realPrompt(m, d); log.push({ f: frame, k: "ans", v }); return v; }
    return answers.length ? answers.shift() : null;
  };
  W.alert = (m) => { if (log) { try { console.log(m); } catch (e) {} } };
  function pathOf(n) {
    if (n === W) return "w";
    if (n === document) return "d";
    if (n === document.documentElement) return "h";
    if (!n || !n.parentNode) return null;
    if (n.id && document.getElementById(n.id) === n) return "#" + n.id;
    const parts = [];
    while (n && n !== document.documentElement) {
      if (n.id && document.getElementById(n.id) === n) { parts.unshift("#" + n.id); break; }
      const p = n.parentNode;
      if (!p) return null;
      parts.unshift(Array.prototype.indexOf.call(p.children, n));
      n = p;
    }
    return parts.join("/");
  }
  function find(p) {
    if (p === "w") return W;
    if (p === "d") return document;
    if (p === "h") return document.documentElement;
    if (!p) return null;
    let n = document.documentElement;
    for (const s of String(p).split("/")) {
      if (s[0] === "#") n = document.getElementById(s.slice(1));
      else n = n && n.children[+s];
      if (!n) return null;
    }
    return n;
  }
  const MOVES = { pointermove: 1, mousemove: 1 };
  const TYPES = ["pointerdown", "pointermove", "pointerup", "pointercancel", "mousedown", "mousemove", "mouseup", "click", "dblclick",
    "contextmenu", "wheel", "keydown", "keyup", "input", "change", "focusin"];
  function rec(e) {
    if (!log || !e.isTrusted) return;
    const p = pathOf(e.target);
    if (p === null) return;
    const r = { f: frame, k: e.type, p };
    if ("clientX" in e) { r.x = e.clientX; r.y = e.clientY; r.b = e.button; r.bs = e.buttons; r.d = e.detail; }
    if ("pointerId" in e) { r.id = e.pointerId; r.pt = e.pointerType; r.pr = e.pressure; r.pm = e.isPrimary; }
    if ("deltaY" in e) { r.dx = e.deltaX; r.dy = e.deltaY; r.dm = e.deltaMode; }
    if ("key" in e) { r.key = e.key; r.code = e.code; r.rp = e.repeat; }
    if ("shiftKey" in e) r.m = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
    if (e.type === "input" || e.type === "change") {
      const t = e.target;
      if ("value" in t) r.v = t.value;
      if ("checked" in t) r.c = t.checked;
      if (t.isContentEditable) r.h = t.innerHTML;
    }
    const last = log[log.length - 1];
    // a label passes its click on to its checkbox; playing the label's click will do that again by itself
    if (e.type === "click" && last && last.k === "click" && last.f === frame) {
      const lt = find(last.p);
      if (lt && lt.tagName === "LABEL" && lt.control === e.target) return;
    }
    // at most one move of each kind per step
    if (MOVES[e.type] && last && last.k === e.type && last.f === frame && last.p === p) { log[log.length - 1] = r; return; }
    log.push(r);
  }
  for (const t of TYPES) W.addEventListener(t, rec, { capture: true, passive: true });
  // ---- playing it back
  function apply(r) {
    if (r.k === "ans") { answers.push(r.v); return; }
    const t = find(r.p);
    if (!t) return;
    const mods = { shiftKey: !!(r.m & 1), ctrlKey: !!(r.m & 2), altKey: !!(r.m & 4), metaKey: !!(r.m & 8) };
    const base = { bubbles: true, cancelable: true, composed: true, view: W, ...mods };
    const mouse = { ...base, clientX: r.x, clientY: r.y, screenX: r.x, screenY: r.y, button: r.b || 0, buttons: r.bs || 0, detail: r.d || 0 };
    const k = r.k;
    try {
      if (k === "focusin") { if (t.focus) t.focus({ preventScroll: true }); return; }
      if (k === "input" || k === "change") {
        // ticking a checkbox or radio is done by its click, which also sends these
        if (t.type === "checkbox" || t.type === "radio") return;
        if (r.v !== undefined && "value" in t && t.value !== r.v) t.value = r.v;
        if (r.h !== undefined) t.innerHTML = r.h;
        t.dispatchEvent(new Event(k, { bubbles: true, cancelable: false }));
        return;
      }
      if (k.startsWith("pointer")) {
        t.dispatchEvent(new W.PointerEvent(k, { ...mouse, pointerId: r.id || 1, pointerType: r.pt || "mouse", pressure: r.pr || 0, isPrimary: r.pm !== false }));
        return;
      }
      if (k === "wheel") { t.dispatchEvent(new W.WheelEvent(k, { ...mouse, deltaX: r.dx || 0, deltaY: r.dy || 0, deltaMode: r.dm || 0 })); return; }
      if (k === "keydown" || k === "keyup") { t.dispatchEvent(new W.KeyboardEvent(k, { ...base, key: r.key, code: r.code, repeat: !!r.rp })); return; }
      t.dispatchEvent(new W.MouseEvent(k, mouse));
    } catch (e) { console.error(e); }
  }
  function step(events) {
    if (events) for (const r of events) apply(r);
    frame++; now = frame * STEP;
    runTimers();
    const list = rafs; rafs = new Map();
    for (const cb of list.values()) { try { cb(now); } catch (e) { console.error(e); } }
  }
  W.__rec = {
    step,
    frame: () => frame,
    record: () => { log = []; },
    stop: () => { const l = log || []; log = null; return l; },
  };
})();
