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
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|[A-Za-zΔ]_[A-Za-z0-9]+|\^-?[0-9A-Za-z]+)/g);
  for (const part of parts) {
    if (!part) continue;
    if (/^\*\*[^*]+\*\*$/.test(part)) frag.append(el("strong", { text: part.slice(2, -2) }));
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

// ---------------------------------------------------------------- page rendering
// opts: { myChoice, closed, onVote(choice), results: {counts,total}, preview }
function renderPage(page, opts = {}) {
  const root = el("div", { class: "cl-page" });
  const blocks = page.blocks || [];
  if (!blocks.length) root.append(el("p", { class: "aero-muted", text: "This page is empty." }));
  for (const b of blocks) {
    if ((b.type === "heading" || b.type === "text") && !(b.text || "").trim()) continue; // skip empty boxes
    if (b.type === "heading") {
      root.append(el("h2", { class: "cl-heading" }, inline(b.text || "")));
    } else if (b.type === "text") {
      root.append(formatText(b.text));
    } else if (b.type === "image") {
      if (!b.imageId) {
        if (opts.preview) root.append(el("p", { class: "aero-muted", text: "(No image chosen yet)" }));
        continue;
      }
      const fig = el(
        "figure",
        { class: "cl-figure size-" + (b.size || "medium") },
        el("img", { src: "/img/" + b.imageId, alt: b.caption || "" }),
        b.caption ? el("figcaption", {}, inline(b.caption)) : null
      );
      root.append(fig);
      if (opts.fullscreen) root.append(fullscreenButton(fig));
    } else if (b.type === "sim") {
      if (!/^(https:\/\/|\/sim\/[a-z0-9]+$)/.test(b.url || "")) {
        if (opts.preview) root.append(el("p", { class: "aero-muted", text: "(Sim link not set yet)" }));
        continue;
      }
      const sim = el(
          "div",
          { class: "cl-sim aero-stage height-" + (b.height || "tall") },
          el("iframe", {
            src: b.url,
            title: "Simulation",
            allow: "fullscreen; autoplay",
            allowfullscreen: true,
            loading: "lazy",
          })
        );
      root.append(sim);
      if (opts.fullscreen) root.append(fullscreenButton(sim));
    } else if (b.type === "video") {
      if (!/^[a-z0-9]{6,24}$/.test(b.videoId || "")) {
        if (opts.preview) root.append(el("p", { class: "aero-muted", text: "(No video chosen yet)" }));
        continue;
      }
      const fig = el("figure", { class: "cl-figure cl-video" },
        el("video", { src: "/video/" + b.videoId, controls: true, controlsList: "nodownload", disablePictureInPicture: true, playsinline: true, preload: "metadata", "data-video-id": b.videoId }),
        b.caption ? el("figcaption", {}, inline(b.caption)) : null);
      root.append(fig);
    } else if (b.type === "poll") {
      root.append(renderPoll(b, opts));
    }
  }
  return root;
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
  const key = JSON.stringify(page);
  if (container._key !== key) {
    container._key = key;
    container.replaceChildren(renderPage(page, opts));
  }
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
