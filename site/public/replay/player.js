// Class Live replay player: plays back recorded actions in a sim that students can watch but not touch.
// Used by the recorder (to watch a recording before saving) and inside every saved replay file.
// classlive: a replay listens for Class Live's pause and resume itself.
function injectHarness(html, harness, cfg) {
  const tag = "<script>window.__RC=" + JSON.stringify(cfg) + ";\n" + harness.replace(/<\/script/gi, "<\\/script") + "</script>";
  let at = 0, m = html.match(/<head[^>]*>/i) || html.match(/<html[^>]*>/i);
  if (m) at = m.index + m[0].length;
  else { m = html.match(/^\s*<!doctype[^>]*>/i); if (m) at = m[0].length; }
  return html.slice(0, at) + tag + html.slice(at);
}

class ReplayPlayer {
  // data: { html, seed, epoch, w, h, area: {x, y, w, h}, frames, events }
  constructor(host, data, harness) {
    this.host = host; this.d = data; this.harness = harness;
    this.playing = false; this.ready = false; this.i = 0; this.acc = 0; this.last = 0; this.wasPlaying = false;
    if (!document.getElementById("rp-style")) {
      const st = document.createElement("style");
      st.id = "rp-style";
      st.textContent = `
.rp { position: absolute; inset: 0; display: flex; flex-direction: column; background: #12291F; font-family: Helvetica, Arial, sans-serif; }
.rp-view { flex: 1; min-height: 0; position: relative; overflow: hidden; }
.rp-clip { position: absolute; overflow: hidden; background: #000; }
.rp-clip iframe { position: absolute; left: 0; top: 0; border: 0; transform-origin: 0 0; background: #fff; }
.rp-block { position: absolute; inset: 0; }
.rp-bar { flex: none; display: flex; align-items: center; gap: 12px; padding: 10px 16px 16px; background: #EDE9E0; color: #12291F; }
.rp-track { flex: 1; height: 8px; border-radius: 4px; background: #D6CFC2; overflow: hidden; }
.rp-fill { height: 100%; width: 0; background: #1E5E46; }
.rp-bar button { font: 600 18px Helvetica, Arial, sans-serif; min-height: 44px; padding: 6px 20px; border-radius: 8px; border: 1px solid #A89E8C; background: #D2CBBD; color: #12291F; cursor: pointer; }
.rp-bar button.rp-main { background: #1E5E46; color: #fff; border-color: #1E5E46; min-width: 110px; }
.rp-time { font-size: 18px; min-width: 110px; text-align: right; font-variant-numeric: tabular-nums; }`;
      document.head.append(st);
    }
    host.innerHTML = "";
    const root = document.createElement("div"); root.className = "rp";
    root.innerHTML = '<div class="rp-view"><div class="rp-clip"><iframe title="Replay"></iframe><div class="rp-block"></div></div></div>' +
      '<div class="rp-bar"><div class="rp-track"><div class="rp-fill"></div></div><span class="rp-time"></span>' +
      '<button class="rp-restart">Restart</button><button class="rp-main">Play</button></div>';
    host.append(root);
    this.view = root.querySelector(".rp-view"); this.clip = root.querySelector(".rp-clip");
    this.frameEl = root.querySelector("iframe"); this.fill = root.querySelector(".rp-fill");
    this.timeEl = root.querySelector(".rp-time"); this.mainBtn = root.querySelector(".rp-main");
    this.mainBtn.onclick = () => (this.playing ? this.pause() : this.play());
    root.querySelector(".rp-restart").onclick = () => this.restart(true);
    new ResizeObserver(() => this.fit()).observe(this.view);
    window.addEventListener("message", (e) => {
      const c = e.data && e.data.classlive;
      if (c === "pause") { this.wasPlaying = this.playing; this.pause(); }
      else if (c === "resume" && this.wasPlaying) this.play();
    });
    this.tick = this.tick.bind(this);
    this.load();
  }
  fit() {
    const a = this.d.area, vw = this.view.clientWidth, vh = this.view.clientHeight;
    if (!vw || !vh) return;
    const s = Math.min(vw / a.w, vh / a.h);
    Object.assign(this.clip.style, { width: a.w * s + "px", height: a.h * s + "px", left: (vw - a.w * s) / 2 + "px", top: (vh - a.h * s) / 2 + "px" });
    Object.assign(this.frameEl.style, { width: this.d.w + "px", height: this.d.h + "px", transform: `translate(${-a.x * s}px, ${-a.y * s}px) scale(${s})` });
  }
  load() {
    this.ready = false; this.i = 0; this.acc = 0;
    this.frameEl.onload = () => {
      this.ready = true;
      this.stepOnce(); // draw the first frame so the sim isn't blank before Play
      this.show();
      if (this.playing) this.last = performance.now();
    };
    this.frameEl.srcdoc = injectHarness(this.d.html, this.harness, { seed: this.d.seed, epoch: this.d.epoch });
    this.fit(); this.show();
  }
  restart(andPlay) { this.playing = false; this.load(); if (andPlay) this.play(); else this.show(); }
  play() {
    if (this.ready && this.win() && this.win().__rec.frame() >= this.d.frames) return this.restart(true);
    this.playing = true; this.last = performance.now(); this.show();
    requestAnimationFrame(this.tick);
  }
  pause() { this.playing = false; this.show(); }
  win() { try { return this.frameEl.contentWindow; } catch (e) { return null; } }
  stepOnce() {
    const w = this.win();
    if (!w || !w.__rec) return;
    const f = w.__rec.frame(), ev = this.d.events, now = [];
    if (f >= this.d.frames) return;
    while (this.i < ev.length && ev[this.i].f <= f) now.push(ev[this.i++]);
    w.__rec.step(now);
  }
  tick(t) {
    if (!this.playing) return;
    const w = this.win();
    if (this.ready && w && w.__rec) {
      this.acc += Math.min(100, t - this.last);
      let n = 0;
      while (this.acc >= 1000 / 60 && n < 4) {
        if (w.__rec.frame() >= this.d.frames) { this.playing = false; break; }
        this.stepOnce();
        this.acc -= 1000 / 60; n++;
      }
      if (n === 4) this.acc = 0;
      this.show();
    }
    this.last = t;
    if (this.playing) requestAnimationFrame(this.tick);
  }
  show() {
    const w = this.win(), f = this.ready && w && w.__rec ? w.__rec.frame() : 0;
    const done = f >= this.d.frames;
    this.fill.style.width = Math.min(100, (100 * f) / Math.max(1, this.d.frames)) + "%";
    const mmss = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
    this.timeEl.textContent = mmss(f / 60) + " / " + mmss(this.d.frames / 60);
    this.mainBtn.textContent = this.playing ? "Pause" : done ? "Play again" : "Play";
  }
}
