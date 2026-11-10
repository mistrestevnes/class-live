// Class Live — server.
// One Durable Object ("main") holds everything: the teacher passcode,
// saved lessons, uploaded images, and the live class session.
// Students and the teacher connect by WebSocket when the network allows it,
// and fall back to ordinary requests every couple of seconds when it doesn't.

import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p.startsWith("/api/") || p === "/ws" || p.startsWith("/img/")) {
      const stub = env.ROOM.get(env.ROOM.idFromName("main"));
      return stub.fetch(request);
    }
    return new Response("Class Live server. Students use the pages.dev address.", { status: 404 });
  },
};

const POLL_PRESENT_MS = 12000; // a polling student counts as connected for this long after each check
const MAX_IMAGE_BYTES = 1_800_000;
const LATE_MS = 4000;        // a student's last save may arrive this long after the timer hits zero
const MAX_ANSWER = 3000;     // characters
const MAX_STUDENT_TOKENS = 600;
const CODE_RE = /^\d{3}[a-z]{4,5}$/; // a student login, like 504cloud

// "Jordan Smith" or "Smith, Jordan" becomes "Jordan S." so full names are never stored.
function cleanName(line) {
  let s = String(line || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  let first, last;
  const comma = s.match(/^([^,]+),\s*(.+)$/);
  if (comma) { last = comma[1].trim(); first = comma[2].trim().split(" ")[0]; }
  else {
    const parts = s.split(" ");
    first = parts[0];
    last = parts.length > 1 ? parts[parts.length - 1] : "";
  }
  if (!last) return first;
  const bare = last.replace(/\.$/, "");
  return first + " " + (bare.length <= 2 ? bare : bare[0]).replace(/^./, (c) => c.toUpperCase()) + ".";
}

const randomPin = () => {
  const a = new Uint16Array(1);
  crypto.getRandomValues(a);
  return String(1000 + (a[0] % 9000));
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const rid = (n = 10) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
};

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Classroom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pollers = new Map(); // sid -> { page, t }
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.live = (await ctx.storage.get("live")) || null;
      this.votes = this.live ? (await ctx.storage.get("votes:" + this.live.sessionId)) || {} : {};
      this.liveLesson = this.live ? (await ctx.storage.get("lesson:" + this.live.lessonId)) || null : null;
      this.tokens = (await ctx.storage.get("tokens")) || [];
      this.sky = (await ctx.storage.get("sky")) || 1;
      this.roster = (await ctx.storage.get("roster")) || { periods: [] };
      this.stokens = (await ctx.storage.get("stokens")) || {};
      const savedQ = await ctx.storage.get("skyq");
      this.skyq = savedQ || {
        1: [{ id: "observeday", type: "written", prompt: "Describe what you observe in the night sky over the course of one full day.", options: [], seconds: 180 }],
        5: [{ id: "rankspeed", type: "rank", prompt: "Drag the planets into order of apparent speed, fastest at the top.", options: ["Jupiter", "Mercury", "Mars", "Saturn", "Venus"], seconds: 180 }],
        15: [{ id: "ballwants", type: "written", prompt: "What does the ball seem to \"want\" to do? How does this conflict with what Aristotle says the ball should \"want\" to do?", options: [], seconds: 180 }],
      };
      // One time only: new pages were added (page 3, Zodiac, and page 13, Four Elements),
      // so saved questions and the current page move to their new numbers.
      if (!(await ctx.storage.get("pages16"))) {
        const had15 = await ctx.storage.get("pages15");
        const renum = (k) => had15 ? (k >= 13 ? k + 1 : k) : (k >= 12 ? k + 2 : k >= 3 ? k + 1 : k);
        if (savedQ) {
          const moved = {};
          for (const [k, list] of Object.entries(savedQ)) moved[renum(Number(k))] = list;
          this.skyq = moved;
          await ctx.storage.put("skyq", moved);
        }
        const n = renum(this.sky);
        if (n !== this.sky) { this.sky = n; await ctx.storage.put("sky", n); }
        await ctx.storage.put("pages16", true);
      }
      // One time only: the three questions for the Slope page (page 16).
      if (!(await ctx.storage.get("slopeq1"))) {
        const qs = [
          { id: "slopepredict", type: "written", prompt: "What do you think will happen if the slope of ramp 2 is reduced to 0°?", options: [], seconds: 180 },
          { id: "slopedescribe", type: "written", prompt: "Describe the motion of the ball.", options: [], seconds: 180 },
          { id: "slopeforce", type: "written", prompt: "What force is causing the ball to move to the right?", options: [], seconds: 180 },
        ];
        const have = new Set((this.skyq[16] || []).map((q) => q.id));
        this.skyq[16] = [...(this.skyq[16] || []), ...qs.filter((q) => !have.has(q.id))];
        await ctx.storage.put("skyq", this.skyq);
        await ctx.storage.put("slopeq1", true);
      }
      this.period = (await ctx.storage.get("skyPeriod")) || null;
      this.run = (await ctx.storage.get("run")) || null;
      this.focus = (await ctx.storage.get("focus")) || null;
      this.shown = (await ctx.storage.get("shown")) || { ids: [], chart: false };
      this.zodiac = (await ctx.storage.get("zodiac")) || { on: false, free: false, points: 0 };
      this.cur = { key: null, data: {} };
      if (this.run) await this.useResponses(this.run.periodId, this.run.qid);
    });
    this.pinFails = new Map(); // studentId -> { n, until }
  }

  // ---------------------------------------------------------------- routing
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;

    try {
      if (p === "/ws") return this.openSocket(request, url);
      if (p.startsWith("/img/") && m === "GET") return this.getImage(p.slice(5));

      // students (no login)
      if (p === "/api/s" && m === "GET") {
        const sid = (url.searchParams.get("sid") || "").slice(0, 40);
        const page = Number(url.searchParams.get("page") || 0);
        if (!sid) return json({ error: "missing sid" }, 400);
        const stu = this.studentFrom(url.searchParams.get("stoken"));
        this.notePoller(sid, page, stu);
        return json(this.studentState(sid, stu));
      }
      if (p === "/api/s" && m === "POST") {
        const body = await request.json();
        const sid = String(body.sid || "").slice(0, 40);
        if (!sid) return json({ error: "missing sid" }, 400);
        const stu = this.studentFrom(body.stoken);
        this.notePoller(sid, body.msg && body.msg.page, stu);
        await this.studentMessage(sid, body.msg || {}, stu);
        return json(this.studentState(sid, stu));
      }

      // student sign-in
      if (p === "/api/slogin" && m === "POST") return this.studentLogin(await request.json());

      // the sky lesson: which page everyone is on
      if (p === "/api/sky" && m === "GET") return json({ n: this.sky });

      // teacher login
      if (p === "/api/auth-status") return json({ setup: !!(await this.ctx.storage.get("auth")) });
      if (p === "/api/setup" && m === "POST") return this.setup(await request.json());
      if (p === "/api/login" && m === "POST") return this.login(await request.json());
      if (p === "/api/reset" && m === "POST") return this.reset(await request.json());

      // everything below needs the teacher token
      if (!this.checkToken(request.headers.get("x-token"))) return json({ error: "not signed in" }, 401);

      if (p === "/api/sky" && m === "POST") {
        const body = await request.json();
        this.sky = Math.max(1, Math.min(18, Math.round(Number(body.n)) || 1));
        await this.ctx.storage.put("sky", this.sky);
        await this.pageChanged();
        this.broadcast();
        return json({ n: this.sky });
      }
      if (p === "/api/roster" && m === "GET") return json(this.roster);
      if (p === "/api/roster" && m === "POST") return this.saveRoster(await request.json());
      if (p === "/api/skyq" && m === "PUT") return this.saveQuestions(await request.json());
      if (p === "/api/skyctl" && m === "POST") {
        const err = await this.skyControl(await request.json());
        if (err) return json({ error: err }, 400);
        return json(await this.teacherState());
      }
      if (p === "/api/skyresults" && m === "GET") return this.results(url.searchParams.get("period"));
      if (p === "/api/account" && m === "GET") return json({ username: ((await this.ctx.storage.get("auth")) || {}).username || "" });
      if (p === "/api/account" && m === "POST") return this.changeAccount(await request.json());
      if (p === "/api/t" && m === "GET") return json(await this.teacherState());
      if (p === "/api/t" && m === "POST") {
        await this.teacherMessage(await request.json());
        return json(await this.teacherState());
      }
      if (p === "/api/lessons" && m === "GET") return json((await this.ctx.storage.get("lessons")) || []);
      const lm = p.match(/^\/api\/lessons\/([a-z0-9]+)$/);
      if (lm && m === "GET") {
        const l = await this.ctx.storage.get("lesson:" + lm[1]);
        return l ? json(l) : json({ error: "not found" }, 404);
      }
      if (lm && m === "PUT") return this.saveLesson(lm[1], await request.json());
      if (lm && m === "DELETE") return this.deleteLesson(lm[1]);
      if (p === "/api/images" && m === "POST") return this.saveImage(request);

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  }

  // ---------------------------------------------------------------- teacher login
  // Checks a new username + passcode, then stores them. Returns an error message or null.
  async storeAuth(username, passcode) {
    username = String(username || "").trim();
    passcode = String(passcode || "");
    if (username.length < 2) return "Choose a username (at least 2 characters).";
    if (passcode.length < 6) return "Use a passcode of at least 6 characters.";
    const salt = rid(16);
    await this.ctx.storage.put("auth", { username, salt, hash: await sha256(salt + passcode) });
    return null;
  }

  async checkPasscode(auth, passcode) {
    return (await sha256(auth.salt + String(passcode || ""))) === auth.hash;
  }

  async slowDown() {
    await new Promise((r) => setTimeout(r, 1000)); // makes guessing slow
  }

  async setup({ username, passcode }) {
    if (await this.ctx.storage.get("auth")) return json({ error: "already set up" }, 400);
    const err = await this.storeAuth(username, passcode);
    if (err) return json({ error: err }, 400);
    return json({ token: await this.newToken() });
  }

  async login({ username, passcode }) {
    const auth = await this.ctx.storage.get("auth");
    if (!auth) return json({ error: "not set up" }, 400);
    const nameOk = !auth.username || auth.username.toLowerCase() === String(username || "").trim().toLowerCase();
    if (!nameOk || !(await this.checkPasscode(auth, passcode))) {
      await this.slowDown();
      return json({ error: "That username or passcode is not right." }, 403);
    }
    return json({ token: await this.newToken() });
  }

  // Forgotten passcode: needs the RESET_KEY secret set from Terminal (see SETUP.txt).
  async reset({ resetKey, username, passcode }) {
    const key = this.env.RESET_KEY;
    if (!key) return json({ error: "No reset key has been set up yet. See “Forgot your passcode” in SETUP.txt." }, 400);
    if (String(resetKey || "") !== key) {
      await this.slowDown();
      return json({ error: "That reset key is not right." }, 403);
    }
    const err = await this.storeAuth(username, passcode);
    if (err) return json({ error: err }, 400);
    this.tokens = []; // sign out every other device
    return json({ token: await this.newToken() });
  }

  async changeAccount({ currentPasscode, username, passcode }) {
    const auth = await this.ctx.storage.get("auth");
    if (!auth || !(await this.checkPasscode(auth, currentPasscode))) {
      await this.slowDown();
      return json({ error: "Your current passcode is not right." }, 403);
    }
    const err = await this.storeAuth(username, passcode || currentPasscode);
    if (err) return json({ error: err }, 400);
    return json({ ok: true });
  }

  async newToken() {
    const t = rid(24);
    this.tokens = [...this.tokens, t].slice(-20);
    await this.ctx.storage.put("tokens", this.tokens);
    return t;
  }

  checkToken(t) {
    return !!t && this.tokens.includes(t);
  }

  // ---------------------------------------------------------------- lessons & images
  async saveLesson(id, lesson) {
    lesson = {
      id,
      title: String(lesson.title || "Untitled lesson").slice(0, 200),
      pages: Array.isArray(lesson.pages) ? lesson.pages : [],
      updated: Date.now(),
    };
    await this.ctx.storage.put("lesson:" + id, lesson);
    const index = ((await this.ctx.storage.get("lessons")) || []).filter((l) => l.id !== id);
    index.unshift({ id, title: lesson.title, pages: lesson.pages.length, updated: lesson.updated });
    await this.ctx.storage.put("lessons", index);
    if (this.live && this.live.lessonId === id) {
      this.liveLesson = lesson;
      this.live.unlocked = Math.min(this.live.unlocked, Math.max(0, lesson.pages.length - 1));
      await this.ctx.storage.put("live", this.live);
      this.broadcast();
    }
    return json({ ok: true, updated: lesson.updated });
  }

  async deleteLesson(id) {
    if (this.live && this.live.lessonId === id) return json({ error: "End the live lesson first." }, 400);
    await this.ctx.storage.delete("lesson:" + id);
    const index = ((await this.ctx.storage.get("lessons")) || []).filter((l) => l.id !== id);
    await this.ctx.storage.put("lessons", index);
    return json({ ok: true });
  }

  async saveImage(request) {
    const type = request.headers.get("content-type") || "";
    if (!/^image\/(jpeg|png|gif|webp)$/.test(type)) return json({ error: "Images only." }, 400);
    const data = await request.arrayBuffer();
    if (data.byteLength > MAX_IMAGE_BYTES) return json({ error: "That image is too large." }, 400);
    const id = rid(12);
    await this.ctx.storage.put("img:" + id, { type, data });
    return json({ id });
  }

  async getImage(id) {
    const img = await this.ctx.storage.get("img:" + id.replace(/[^a-z0-9]/g, ""));
    if (!img) return new Response("not found", { status: 404 });
    return new Response(img.data, {
      headers: { "content-type": img.type, "cache-control": "public, max-age=31536000, immutable" },
    });
  }

  // ---------------------------------------------------------------- live session
  pages() {
    return (this.liveLesson && this.liveLesson.pages) || [];
  }

  async teacherMessage(msg) {
    switch (msg.t) {
      case "start": {
        const lesson = await this.ctx.storage.get("lesson:" + msg.lessonId);
        if (!lesson) return;
        if (this.live) await this.ctx.storage.delete("votes:" + this.live.sessionId);
        this.live = { sessionId: rid(8), lessonId: lesson.id, unlocked: 0, revealed: {}, startedAt: Date.now() };
        this.liveLesson = lesson;
        this.votes = {};
        await this.ctx.storage.put("live", this.live);
        break;
      }
      case "end": {
        if (this.live) await this.ctx.storage.delete("votes:" + this.live.sessionId);
        this.live = null;
        this.liveLesson = null;
        this.votes = {};
        await this.ctx.storage.delete("live");
        break;
      }
      case "unlock": {
        if (!this.live) return;
        const n = Math.max(0, Math.min(Number(msg.to) || 0, this.pages().length - 1));
        this.live.unlocked = n;
        await this.ctx.storage.put("live", this.live);
        break;
      }
      case "reveal": {
        if (!this.live) return;
        if (msg.on) this.live.revealed[msg.pageId] = true;
        else delete this.live.revealed[msg.pageId];
        await this.ctx.storage.put("live", this.live);
        break;
      }
      case "clearVotes": {
        if (!this.live) return;
        delete this.votes[msg.pageId];
        delete this.live.revealed[msg.pageId];
        await this.ctx.storage.put("live", this.live);
        await this.ctx.storage.put("votes:" + this.live.sessionId, this.votes);
        break;
      }
      default:
        return; // "refresh" and unknown messages change nothing
    }
    this.broadcast();
  }

  async studentMessage(sid, msg, stu) {
    if (msg.t === "answer") return this.saveAnswer(msg, stu);
    if (msg.t === "work") return this.saveWork(msg, stu);
    if (msg.t === "away") {
      if (!stu) return;
      this.away ||= {};
      const per = (this.away[stu.periodId] ||= {});
      const a = (per[stu.id] ||= { name: stu.name, away: false, why: "", since: 0, count: 0, ms: 0 });
      const now = Date.now(), goingAway = !!msg.away;
      if (goingAway && !a.away) { a.count++; a.since = now; }
      if (!goingAway && a.away) a.ms += now - a.since;
      a.away = goingAway; a.why = goingAway ? String(msg.why || "").slice(0, 40) : a.why;
      this.broadcast({ teachersOnly: true });
      return;
    }
    if (msg.t !== "vote" || !this.live) return;
    const pages = this.pages();
    const idx = pages.findIndex((pg) => pg.id === msg.pageId);
    if (idx < 0 || idx > this.live.unlocked) return;
    if (this.live.revealed[msg.pageId]) return; // voting closed
    const poll = (pages[idx].blocks || []).find((b) => b.type === "poll");
    const choice = Number(msg.choice);
    if (!poll || !Number.isInteger(choice) || choice < 0 || choice >= (poll.options || []).length) return;
    (this.votes[msg.pageId] ||= {})[sid] = choice;
    await this.ctx.storage.put("votes:" + this.live.sessionId, this.votes);
    this.broadcast({ teachersOnly: true });
    this.sendToStudent(sid);
  }

  studentState(sid, stu) {
    return { ...this.lessonState(sid), sky: this.sky, signedIn: !!stu, me: stu ? stu.name : null, q: this.studentQuestion(stu), zodiac: this.zodiac };
  }

  // ---------------------------------------------------------------- student sign-in
  studentFrom(token) {
    const t = token && this.stokens[String(token)];
    if (!t) return null;
    const pd = this.roster.periods.find((x) => x.id === t.periodId);
    const st = pd && pd.students.find((x) => x.id === t.studentId);
    return st ? { id: st.id, name: st.name, periodId: pd.id } : null;
  }

  // A student signs in with their code alone, like 504cloud. The server holds codes only, never names.
  async studentLogin({ code, sid }) {
    const key = "sid:" + String(sid || "").slice(0, 40);
    const f = this.pinFails.get(key) || { n: 0, until: 0 };
    if (Date.now() < f.until) return json({ error: "Too many tries. Wait one minute, then try again." }, 429);
    const c = String(code || "").toLowerCase().replace(/\s+/g, "");
    let pd = null, st = null;
    if (CODE_RE.test(c)) {
      for (const x of this.roster.periods) {
        const y = x.students.find((s) => s.code === c);
        if (y) { pd = x; st = y; break; }
      }
    }
    if (!st) {
      f.n++;
      if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; }
      this.pinFails.set(key, f);
      await this.slowDown();
      return json({ error: this.roster.periods.length ? "That code is not right. Check it and try again." : "The class list is not set up yet. Tell your teacher." }, 403);
    }
    this.pinFails.delete(key);
    const token = rid(24);
    const keys = Object.keys(this.stokens);
    if (keys.length >= MAX_STUDENT_TOKENS) delete this.stokens[keys[0]];
    this.stokens[token] = { studentId: st.id, periodId: pd.id };
    await this.ctx.storage.put("stokens", this.stokens);
    return json({ token, name: st.name });
  }

  async saveRoster({ periods }) {
    if (!Array.isArray(periods)) return json({ error: "No class periods sent." }, 400);
    const out = [];
    const seen = new Set();
    for (const raw of periods) {
      const name = String(raw.name || "").trim().slice(0, 40);
      if (!name) return json({ error: "Every class needs a name, like 5th Block." }, 400);
      const old = this.roster.periods.find((x) => x.id === raw.id);
      const byCode = new Map((old ? old.students : []).filter((st) => st.code).map((st) => [st.code, st]));
      const students = [];
      for (const line of raw.codes || []) {
        const c = String(line || "").toLowerCase().replace(/\s+/g, "");
        if (!c) continue;
        if (!CODE_RE.test(c)) return json({ error: "\"" + String(line).trim().slice(0, 30) + "\" is not a login code. Codes look like 504cloud: three digits, then a 4 or 5 letter word. Names don't go here." }, 400);
        if (seen.has(c)) return json({ error: c + " is listed twice. Every student needs their own code." }, 400);
        seen.add(c);
        students.push(byCode.get(c) || { id: rid(8), code: c, name: c });
      }
      out.push({ id: old ? old.id : rid(6), name, students });
    }
    this.roster = { periods: out };
    await this.ctx.storage.put("roster", this.roster);
    if (!out.some((x) => x.id === this.period)) {
      this.period = out.length ? out[0].id : null;
      await this.ctx.storage.put("skyPeriod", this.period);
    }
    this.broadcast();
    return json(this.roster);
  }

  // ---------------------------------------------------------------- sky questions
  findQuestion(qid) {
    for (const [page, list] of Object.entries(this.skyq)) {
      const q = (list || []).find((x) => x.id === qid);
      if (q) return { ...q, page: Number(page) };
    }
    return null;
  }

  async saveQuestions({ qs }) {
    const out = {};
    const keep = new Set();
    for (let n = 1; n <= 18; n++) {
      const list = (qs && qs[n]) || [];
      const clean = [];
      for (const raw of list) {
        const type = raw.type === "mc" || raw.type === "rank" ? raw.type : "written";
        const prompt = String(raw.prompt || "").trim().slice(0, 1000);
        if (!prompt) return json({ error: "A question on page " + n + " has no prompt." }, 400);
        const options = type !== "written" ? (raw.options || []).map((o) => String(o).trim().slice(0, 200)).filter(Boolean).slice(0, 10) : [];
        if (type !== "written" && options.length < 2) return json({ error: "This question needs at least two choices." }, 400);
        const seconds = Math.max(0, Math.min(3600, Math.round(Number(raw.seconds)) || 0));
        const id = /^[a-z0-9]{4,16}$/.test(raw.id || "") ? raw.id : rid(8);
        keep.add(id);
        clean.push({ id, type, prompt, options, seconds });
      }
      if (clean.length) out[n] = clean;
    }
    if (this.run && !keep.has(this.run.qid)) return json({ error: "That question is running. Close it first." }, 400);
    this.skyq = out;
    await this.ctx.storage.put("skyq", out);
    this.broadcast();
    return json({ qs: out });
  }

  respKey(periodId, qid) {
    return "resp:" + periodId + ":" + qid;
  }

  // Keeps the running question's responses in memory.
  async useResponses(periodId, qid) {
    const key = this.respKey(periodId, qid);
    if (this.cur.key === key) return;
    this.cur = { key, data: (await this.ctx.storage.get(key)) || {} };
  }

  async responsesFor(periodId, qid) {
    const key = this.respKey(periodId, qid);
    return key === this.cur.key ? this.cur.data : (await this.ctx.storage.get(key)) || {};
  }

  remainingMs() {
    if (!this.run || this.run.endsAt === null) return null;
    return Math.max(0, this.run.endsAt - Date.now());
  }

  runClosed() {
    return !!this.run && this.run.endsAt !== null && Date.now() >= this.run.endsAt;
  }

  studentQuestion(stu) {
    if (!stu || !this.run || this.run.periodId !== stu.periodId) return null;
    const q = this.findQuestion(this.run.qid);
    if (!q) return null;
    return {
      runId: this.run.runId,
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      options: q.options,
      remainingMs: this.remainingMs(),
      closed: this.runClosed(),
      mine: this.cur.data[stu.id] || null,
    };
  }

  // What a student has chosen on a sky page (e.g. the Friction graph steps), shown on the laptop.
  async workFor(periodId) {
    this.workCache ||= {};
    if (!this.workCache[periodId]) this.workCache[periodId] = (await this.ctx.storage.get("work:" + periodId)) || {};
    return this.workCache[periodId];
  }
  async saveWork(msg, stu) {
    if (!stu) return;
    const page = Math.round(Number(msg.page));
    if (!(page >= 1 && page <= 18)) return;
    const data = msg.data && typeof msg.data === "object" ? msg.data : null;
    if (!data || JSON.stringify(data).length > 4000) return;
    const w = await this.workFor(stu.periodId);
    (w[page] ||= {})[stu.id] = { name: stu.name, data, t: Date.now() };
    await this.ctx.storage.put("work:" + stu.periodId, w);
    this.broadcast({ teachersOnly: true });
  }

  async saveAnswer(msg, stu) {
    if (!stu || !this.run || this.run.periodId !== stu.periodId || msg.qid !== this.run.qid) return;
    if (this.run.endsAt !== null && Date.now() > this.run.endsAt + LATE_MS) return;
    const q = this.findQuestion(msg.qid);
    if (!q) return;
    if (q.type === "rank") {
      const o = Array.isArray(msg.order) ? msg.order.map(Number) : [];
      if (o.length !== q.options.length || [...o].sort((a, b) => a - b).some((v, i) => v !== i)) return;
      this.cur.data[stu.id] = { order: o, t: Date.now() };
    } else if (q.type === "mc") {
      const c = Number(msg.choice);
      if (!Number.isInteger(c) || c < 0 || c >= q.options.length) return;
      this.cur.data[stu.id] = { choice: c, t: Date.now() };
    } else {
      const text = String(msg.text || "").slice(0, MAX_ANSWER);
      if (text.trim()) this.cur.data[stu.id] = { text, t: Date.now() };
      else delete this.cur.data[stu.id];
    }
    await this.ctx.storage.put(this.cur.key, this.cur.data);
    this.broadcast({ teachersOnly: true });
  }

  async putRun() {
    if (this.run) await this.ctx.storage.put("run", this.run);
    else await this.ctx.storage.delete("run");
    if (this.run && this.run.endsAt !== null && !this.runClosed()) await this.ctx.storage.setAlarm(this.run.endsAt);
    else await this.ctx.storage.deleteAlarm();
  }

  async putFocus(qid) {
    this.focus = qid || null;
    this.shown = { ids: [], chart: false };
    await this.ctx.storage.put("focus", this.focus);
    await this.ctx.storage.put("shown", this.shown);
  }

  async pageChanged() {
    if (this.run && this.runClosed()) {
      this.run = null;
      await this.putRun();
    }
    if (!this.run) {
      const list = this.skyq[this.sky] || [];
      await this.putFocus(list.length ? list[0].id : null);
    } else {
      // a question is still running: keep it, but take answers off the iPad so the new page shows
      this.shown = { ids: [], chart: false };
      await this.ctx.storage.put("shown", this.shown);
    }
  }

  // The timer ran out: tell everyone.
  async alarm() {
    this.broadcast();
  }

  async skyControl(c) {
    const now = Date.now();
    switch (c.t) {
      case "period": {
        if (this.run && !this.runClosed()) return "Close the running question first.";
        if (!this.roster.periods.some((x) => x.id === c.id)) return "That class period is not on the roster.";
        this.period = c.id;
        await this.ctx.storage.put("skyPeriod", this.period);
        this.run = null;
        await this.putRun();
        await this.putFocus(this.focus);
        break;
      }
      case "focus": {
        if (this.run && !this.runClosed() && c.qid !== this.run.qid) return "Close the running question first.";
        await this.putFocus(c.qid);
        break;
      }
      case "start": {
        const q = this.findQuestion(c.qid);
        if (!q) return "That question is gone.";
        if (!this.period) return "Add a class period on the Roster tab first.";
        this.run = {
          runId: rid(6),
          qid: q.id,
          periodId: this.period,
          startedAt: now,
          endsAt: q.seconds ? now + q.seconds * 1000 : null,
        };
        await this.useResponses(this.period, q.id);
        await this.putFocus(q.id);
        await this.putRun();
        break;
      }
      case "end": {
        if (!this.run) return null;
        this.run.endsAt = now;
        await this.putRun();
        break;
      }
      case "extend": {
        if (!this.run || this.run.endsAt === null) return null;
        this.run.endsAt = Math.max(now, this.run.endsAt) + Math.max(5, Math.min(600, Number(c.s) || 30)) * 1000;
        await this.putRun();
        break;
      }
      case "dismiss": {
        this.run = null;
        await this.putRun();
        break;
      }
      case "show": {
        const ids = this.shown.ids.filter((x) => x !== c.studentId);
        if (c.on) ids.push(String(c.studentId));
        this.shown = { ...this.shown, ids };
        await this.ctx.storage.put("shown", this.shown);
        break;
      }
      case "chart": {
        this.shown = { ...this.shown, chart: !!c.on };
        await this.ctx.storage.put("shown", this.shown);
        break;
      }
      case "clearAway": {
        if (this.away) this.away[this.period] = {};
        break;
      }
      case "clearShown": {
        this.shown = { ids: [], chart: false };
        await this.ctx.storage.put("shown", this.shown);
        break;
      }
      case "clearResponses": {
        if (this.run && this.run.qid === c.qid && !this.runClosed()) return "Close the running question first.";
        const key = this.respKey(this.period, c.qid);
        await this.ctx.storage.delete(key);
        if (this.cur.key === key) this.cur = { key: null, data: {} };
        this.shown = { ids: [], chart: false };
        await this.ctx.storage.put("shown", this.shown);
        break;
      }
      case "zodiac": {
        this.zodiac = { on: c.on === undefined ? this.zodiac.on : !!c.on, free: c.free === undefined ? this.zodiac.free : !!c.free, points: c.points === undefined ? this.zodiac.points || 0 : Math.max(0, Math.min(3, Number(c.points) || 0)) };
        await this.ctx.storage.put("zodiac", this.zodiac);
        break;
      }
      case "signOutAll": {
        this.stokens = {};
        await this.ctx.storage.put("stokens", {});
        break;
      }
      default:
        return "Unknown action.";
    }
    this.broadcast();
    return null;
  }

  async skyTeacherState() {
    const pd = this.roster.periods.find((x) => x.id === this.period) || null;
    const students = pd ? pd.students : [];
    const q = this.focus ? this.findQuestion(this.focus) : null;
    const resp = q && pd ? await this.responsesFor(pd.id, q.id) : {};
    const responses = students
      .filter((st) => resp[st.id])
      .map((st) => ({ studentId: st.id, name: st.name, ...resp[st.id], shown: this.shown.ids.includes(st.id) }))
      .sort((a, b) => a.t - b.t);
    const missing = students.filter((st) => !resp[st.id]).map((st) => st.name);
    let counts = null;
    if (q && q.type === "mc") {
      counts = q.options.map(() => 0);
      for (const r of responses) if (r.choice < counts.length) counts[r.choice]++;
    }
    let rankAvg = null;
    if (q && q.type === "rank") {
      const sum = q.options.map(() => 0);
      for (const r of responses) r.order.forEach((opt, place) => (sum[opt] += place + 1));
      rankAvg = q.options.map((o, i) => ({ name: o, avg: responses.length ? sum[i] / responses.length : 0 })).sort((a, b) => a.avg - b.avg);
    }
    // What the iPad shows. Never includes names.
    const present = { items: [], chart: null };
    if (q) {
      const list = this.shown.ids.map((id) => resp[id]).filter(Boolean);
      present.prompt = q.prompt;
      present.items = q.type === "written" ? list.map((r) => r.text) : [];
      if (q.type === "mc" && this.shown.chart) present.chart = { options: q.options, counts, total: responses.length };
    }
    const connected = new Set();
    for (const ws of this.ctx.getWebSockets("student")) {
      if (ws.readyState !== 1) continue;
      const stu = this.studentFrom((ws.deserializeAttachment() || {}).stoken);
      if (stu) connected.add(stu.id);
    }
    const now = Date.now();
    for (const info of this.pollers.values()) if (info.stuId && now - info.t <= POLL_PRESENT_MS) connected.add(info.stuId);
    return {
      n: this.sky,
      zodiac: this.zodiac,
      periodId: this.period,
      periods: this.roster.periods.map((x) => ({ id: x.id, name: x.name, count: x.students.length })),
      qs: this.skyq,
      away: pd && this.away && this.away[pd.id] ? Object.values(this.away[pd.id]).filter((a) => a.count).map((a) => ({ ...a, ms: a.ms + (a.away ? Date.now() - a.since : 0) })).sort((a, b) => (b.away - a.away) || a.name.localeCompare(b.name)) : [],
      work: pd ? Object.values((await this.workFor(pd.id))[this.sky] || {}).sort((a, b) => a.name.localeCompare(b.name)) : [],
      focus: q,
      runPrompt: this.run ? ((this.findQuestion(this.run.qid) || {}).prompt || "") : "",
      run: this.run
        ? { qid: this.run.qid, periodId: this.run.periodId, remainingMs: this.remainingMs(), closed: this.runClosed() }
        : null,
      responses,
      missing,
      answered: responses.length,
      total: students.length,
      counts,
      rankAvg,
      chart: this.shown.chart,
      signedIn: students.filter((st) => connected.has(st.id)).length,
      present,
    };
  }

  async results(periodId) {
    const pd = this.roster.periods.find((x) => x.id === periodId);
    if (!pd) return json({ error: "Choose a class period." }, 400);
    const questions = [];
    const answers = {};
    for (let n = 1; n <= 18; n++) {
      for (const q of this.skyq[n] || []) {
        questions.push({ ...q, page: n });
        answers[q.id] = await this.responsesFor(pd.id, q.id);
      }
    }
    return json({ questions, students: pd.students.map((st) => ({ id: st.id, name: st.name })), answers });
  }

  lessonState(sid) {
    if (!this.live || !this.liveLesson) return { live: false };
    const unlocked = this.live.unlocked;
    const pages = this.pages().slice(0, unlocked + 1);
    const myVotes = {};
    const closed = {};
    for (const pg of pages) {
      const v = this.votes[pg.id];
      if (v && sid in v) myVotes[pg.id] = v[sid];
      if (this.live.revealed[pg.id]) closed[pg.id] = true;
    }
    return {
      live: true,
      sessionId: this.live.sessionId,
      title: this.liveLesson.title,
      unlocked,
      total: this.pages().length,
      pages,
      myVotes,
      closed,
    };
  }

  presence() {
    const now = Date.now();
    const seen = new Map(); // sid -> { page, mode }
    for (const ws of this.ctx.getWebSockets("student")) {
      if (ws.readyState !== 1) continue; // closing or closed
      const a = ws.deserializeAttachment() || {};
      if (a.sid) seen.set(a.sid, { page: a.page || 0, mode: "live" });
    }
    for (const [sid, info] of this.pollers) {
      if (now - info.t > POLL_PRESENT_MS) this.pollers.delete(sid);
      else if (!seen.has(sid)) seen.set(sid, { page: info.page || 0, mode: "polling" });
    }
    const onPage = {};
    let live = 0;
    for (const v of seen.values()) {
      onPage[v.page] = (onPage[v.page] || 0) + 1;
      if (v.mode === "live") live++;
    }
    return { count: seen.size, live, polling: seen.size - live, onPage };
  }

  async teacherState() {
    const tallies = {};
    if (this.live) {
      for (const pg of this.pages()) {
        const poll = (pg.blocks || []).find((b) => b.type === "poll");
        if (!poll) continue;
        const counts = (poll.options || []).map(() => 0);
        const v = this.votes[pg.id] || {};
        for (const c of Object.values(v)) if (c < counts.length) counts[c]++;
        tallies[pg.id] = { counts, total: Object.keys(v).length };
      }
    }
    return {
      live: this.live,
      lesson: this.liveLesson,
      tallies,
      presence: this.presence(),
      sky: await this.skyTeacherState(),
    };
  }

  notePoller(sid, page, stu) {
    const prev = this.pollers.get(sid);
    const pg = Number(page) || 0;
    this.pollers.set(sid, { page: pg, t: Date.now(), stuId: stu ? stu.id : null });
    if (!prev || prev.page !== pg) this.broadcast({ teachersOnly: true });
  }

  // ---------------------------------------------------------------- websockets
  openSocket(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const role = url.searchParams.get("role");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (role === "teacher") {
      if (!this.checkToken(url.searchParams.get("token"))) return new Response("not signed in", { status: 401 });
      this.ctx.acceptWebSocket(server, ["teacher"]);
      server.serializeAttachment({ role: "teacher" });
    } else {
      const sid = (url.searchParams.get("sid") || "").slice(0, 40);
      if (!sid) return new Response("missing sid", { status: 400 });
      this.ctx.acceptWebSocket(server, ["student"]);
      server.serializeAttachment({
        role: "student",
        sid,
        page: Number(url.searchParams.get("page")) || 0,
        stoken: (url.searchParams.get("stoken") || "").slice(0, 40),
      });
    }
    // send the first state once the socket is live
    this.ctx.waitUntil(
      (async () => {
        await null;
        try {
          if (role === "teacher") server.send(JSON.stringify({ t: "tstate", state: await this.teacherState() }));
          else {
            const a = server.deserializeAttachment();
            server.send(JSON.stringify({ t: "state", state: this.studentState(a.sid, this.studentFrom(a.stoken)) }));
            this.broadcast({ teachersOnly: true });
          }
        } catch {}
      })()
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const a = ws.deserializeAttachment() || {};
    if (a.role === "teacher") {
      if (msg.t === "refresh") ws.send(JSON.stringify({ t: "tstate", state: await this.teacherState() }));
      else await this.teacherMessage(msg);
    } else if (a.role === "student") {
      if (msg.t === "page") {
        a.page = Number(msg.page) || 0;
        ws.serializeAttachment(a);
        this.broadcast({ teachersOnly: true });
      } else {
        await this.studentMessage(a.sid, msg, this.studentFrom(a.stoken));
        if (msg.t === "answer") ws.send(JSON.stringify({ t: "saved", n: msg.n }));
      }
    }
  }

  async webSocketClose(ws) {
    try {
      ws.close();
    } catch {}
    this.broadcast({ teachersOnly: true });
  }

  async webSocketError(ws) {
    this.broadcast({ teachersOnly: true });
  }

  sendToStudent(sid) {
    for (const ws of this.ctx.getWebSockets("student")) {
      const a = ws.deserializeAttachment() || {};
      if (a.sid === sid) {
        try {
          ws.send(JSON.stringify({ t: "state", state: this.studentState(sid, this.studentFrom(a.stoken)) }));
        } catch {}
      }
    }
  }

  broadcast({ teachersOnly = false } = {}) {
    this.ctx.waitUntil(
      (async () => {
        const t = JSON.stringify({ t: "tstate", state: await this.teacherState() });
        for (const ws of this.ctx.getWebSockets("teacher")) {
          try {
            ws.send(t);
          } catch {}
        }
        if (teachersOnly) return;
        for (const ws of this.ctx.getWebSockets("student")) {
          const a = ws.deserializeAttachment() || {};
          try {
            ws.send(JSON.stringify({ t: "state", state: this.studentState(a.sid, this.studentFrom(a.stoken)) }));
          } catch {}
        }
      })()
    );
  }
}
