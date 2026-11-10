// Class Live freeze — paste this at the very top of a sim's head section, inside a script tag,
// before any of the sim's own code. When the teacher pauses Class Live or pushes a question,
// the sim stops exactly where it is; when they resume, it carries on as if no time passed.
// Works for sims that animate with requestAnimationFrame and measure time with performance.now() or Date.now().
// A sim can also define window.classlivePause / window.classliveResume to do extra things (stop a timer, etc.).
(function () {
  let paused = false, pausedAt = 0, pausedAtDate = 0, offset = 0, held = [];
  const rAF = window.requestAnimationFrame.bind(window);
  const perfNow = performance.now.bind(performance);
  const dateNow = Date.now;
  performance.now = () => (paused ? pausedAt : perfNow()) - offset;
  Date.now = () => (paused ? pausedAtDate : dateNow()) - offset;
  window.requestAnimationFrame = (cb) => {
    if (paused) { held.push(cb); return 0; }
    return rAF((t) => cb(t - offset));
  };
  function pause() {
    if (paused) return;
    pausedAt = perfNow(); pausedAtDate = dateNow(); paused = true;
    for (const m of document.querySelectorAll("video, audio")) if (!m.paused) { m.pause(); m.dataset.clResume = "1"; }
    if (window.classlivePause) try { window.classlivePause(); } catch (e) {}
  }
  function resume() {
    if (!paused) return;
    offset += perfNow() - pausedAt; paused = false;
    const h = held; held = [];
    for (const cb of h) rAF((t) => cb(t - offset));
    for (const m of document.querySelectorAll("video, audio")) if (m.dataset.clResume) { delete m.dataset.clResume; m.play().catch(() => {}); }
    if (window.classliveResume) try { window.classliveResume(); } catch (e) {}
  }
  window.addEventListener("message", (e) => {
    const c = e.data && e.data.classlive;
    if (c === "pause") pause();
    else if (c === "resume") resume();
  });
})();
