// Class Live — server.
// One Durable Object ("main") holds everything: the teacher passcode,
// saved lessons, uploaded images, and the live class session.
// Students and the teacher connect by WebSocket when the network allows it,
// and fall back to ordinary requests every couple of seconds when it doesn't.

import { DurableObject } from "cloudflare:workers";
import { FREEZE_JS } from "./freeze.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p.startsWith("/api/") || p === "/ws" || p.startsWith("/img/") || p.startsWith("/sim/")) {
      const stub = env.ROOM.get(env.ROOM.idFromName("main"));
      return stub.fetch(request);
    }
    if (p.startsWith("/video/") && ["GET", "HEAD"].includes(request.method)) return serveVideo(request, env, p.slice(7));
    return new Response("Class Live server. Students use classlive.scienceworks.xyz.", { status: 404 });
  },
};

// A video from the R2 bucket. Range requests are answered so the player can skip around and start quickly.
async function serveVideo(request, env, rawId) {
  const id = rawId.replace(/\.[a-z0-9]+$/, "");
  if (!env.VIDEOS || !/^[a-z0-9]{6,24}$/.test(id)) return new Response("not found", { status: 404 });
  const range = request.headers.get("range");
  const obj = request.method === "HEAD" ? await env.VIDEOS.head("v/" + id) : await env.VIDEOS.get("v/" + id, range ? { range: request.headers } : undefined);
  if (!obj) return new Response("not found", { status: 404 });
  const size = obj.size;
  const headers = new Headers({
    "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=86400",
    etag: obj.httpEtag,
  });
  const r = obj.range;
  if (range && r && "offset" in r) {
    const start = r.offset ?? 0, len = r.length ?? size - start;
    headers.set("content-range", "bytes " + start + "-" + (start + len - 1) + "/" + size);
    headers.set("content-length", String(len));
    return new Response(request.method === "HEAD" ? null : obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(size));
  return new Response(request.method === "HEAD" ? null : obj.body, { headers });
}

const POLL_PRESENT_MS = 12000; // a polling student counts as connected for this long after each check
const MAX_IMAGE_BYTES = 1_800_000;
const MAX_SIM_BYTES = 1_900_000; // one uploaded sim file
const ASK_GRACE = 6000; // students' answers are still saved for 5 s after time runs out
const MAX_VIDEO_BYTES = 90_000_000; // one uploaded video (the site passes requests up to 100 MB)
const VIDEO_TYPES = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
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

// When each block's class turns itself off (Central time). The block is found by the first number in its name: "1st Block" -> 1.
const AUTO_END = { 1: { mt: [10, 13], f: [10, 7] }, 2: { mt: [11, 58], f: [11, 48] }, 5: { mt: [16, 5], f: [16, 5] } };
const TZ = "America/Chicago";
function zoneParts(ms) {
  const o = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(ms)) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd: o.weekday };
}
// a wall-clock time in Central time -> milliseconds
function zoneTime(y, mo, d, h, mi) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let k = 0; k < 2; k++) {
    const p = zoneParts(guess);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += Date.UTC(y, mo - 1, d, h, mi) - shown;
  }
  return guess;
}
// the next end of this block's class on a school day (Monday to Friday), or null for a block without a set time
function autoEndTime(periodName, now) {
  const m = String(periodName || "").match(/\d/);
  const sch = m && AUTO_END[m[0]];
  if (!sch) return null;
  for (let k = 0; k < 8; k++) {
    const p = zoneParts(now + k * 86400000);
    if (p.wd === "Sat" || p.wd === "Sun") continue;
    const [h, mi] = p.wd === "Fri" ? sch.f : sch.mt;
    const t = zoneTime(p.y, p.mo, p.d, h, mi);
    if (t > now) return t;
  }
  return null;
}

// ---------------------------------------------------------------- lesson plans
// A lesson has pages (what students see) and a plan: the list of things done in class. A plan item can send students
// to a page and can hold the questions for that part of the class. Older lessons kept questions on pages; those
// become plan items the first time the lesson is read.
function cleanPlan(plan, pages) {
  const ids = new Set((pages || []).map((p) => p.id));
  return (Array.isArray(plan) ? plan : []).slice(0, 80).filter((x) => x && typeof x === "object").map((x) => ({
    id: String(x.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || rid(8),
    title: String(x.title || "").slice(0, 200),
    notes: String(x.notes || "").slice(0, 4000),
    pageId: ids.has(x.pageId) ? x.pageId : "",
    questions: Array.isArray(x.questions) ? x.questions.slice(0, 40) : [],
  }));
}
function withPlan(lesson) {
  if (!lesson) return lesson;
  if (Array.isArray(lesson.plan)) return lesson;
  const pages = Array.isArray(lesson.pages) ? lesson.pages : [];
  const plan = [];
  pages.forEach((pg, i) => {
    if (Array.isArray(pg.questions) && pg.questions.length) plan.push({ id: rid(8), title: pg.name || "Page " + (i + 1), notes: "", pageId: pg.id, questions: pg.questions });
  });
  return { ...lesson, plan, pages: pages.map(({ questions, ...pg }) => pg) };
}
// which level a block teaches: the first number in its name (1st and 5th honors, 2nd enriched)
const BLOCK_LEVEL = { 1: "honors", 5: "honors", 2: "enriched" };
function levelOfBlock(name) { const m = String(name || "").match(/\d/); return (m && BLOCK_LEVEL[m[0]]) || ""; }

// Waiting-room trivia: {on, list:[{id, text, imageId, options[2-5], answer, why}]}. Kept in one record.
function cleanTrivia(t) {
  const clip = (x, n) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n);
  const list = [];
  for (const q of (t && Array.isArray(t.list) ? t.list : []).slice(0, 300)) {
    const options = (Array.isArray(q && q.options) ? q.options : []).map((o) => clip(o, 140)).slice(0, 5);
    if (options.length < 2) continue;
    const answer = Number.isInteger(q.answer) && q.answer >= 0 && q.answer < options.length ? q.answer : 0;
    list.push({ id: /^[a-z0-9]{4,24}$/.test(q.id || "") ? q.id : rid(8), text: clip(q.text, 400), options, answer, why: clip(q.why, 400),
      imageId: /^[a-z0-9]{6,24}$/.test(q.imageId || "") ? q.imageId : "" });
  }
  return { on: !(t && t.on === false), list };
}

// What a sim can tell Class Live (events) and be told by it (commands).
// A sim may list them in <script type="application/json" id="classlive-events">{"events":{"name":"what it means"},"commands":{...}}</script>.
// The file is also scanned for names it sends or listens for, so sims without a list still work.
// Each item: {name, says, listed (in the sim's list), found (in the sim's code)}.
function simManifest(html) {
  const out = { events: [], commands: [] };
  let listed = { events: {}, commands: {} };
  const m = html.match(/<script[^>]*id=["']classlive-events["'][^>]*>([\s\S]*?)<\/script>/i);
  if (m) { try { const j = JSON.parse(m[1]); listed = { events: j.events || {}, commands: j.commands || {} }; } catch {} }
  const name = (x) => /^[A-Za-z][\w-]{0,40}$/.test(x);
  const scan = (res) => { const set = new Set(); for (const re of res) for (const r of html.matchAll(re)) if (name(r[1])) set.add(r[1]); return set; };
  const foundE = scan([/classliveEvent\s*:\s*["'`]([\w-]+)["'`]/g]);
  const foundC = scan([/classliveCommand\s*={2,3}\s*["'`]([\w-]+)["'`]/g, /["'`]([\w-]+)["'`]\s*={2,3}\s*[\w.$\[\]]*classliveCommand/g]);
  const cases = scan([/case\s*["'`]([\w-]+)["'`]\s*:/g]); // a switch label only counts for a command the sim lists
  const build = (kind, found) => {
    const l = Array.isArray(listed[kind]) ? Object.fromEntries(listed[kind].map((x) => [x.name, x.says])) : listed[kind];
    const names = new Set([...Object.keys(l).filter(name), ...found]);
    return [...names].map((n) => ({ name: n, says: typeof l[n] === "string" ? l[n].slice(0, 200) : "", listed: n in l, found: found.has(n) || (kind === "commands" && n in l && cases.has(n)) }));
  };
  out.events = build("events", foundE); out.commands = build("commands", foundC);
  return out;
}

export class Classroom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pollers = new Map(); // sid -> { page, t }
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.live = (await ctx.storage.get("live")) || null;
      this.votes = this.live ? (await ctx.storage.get("votes:" + this.live.sessionId)) || {} : {};
      this.watch = this.live ? (await ctx.storage.get("watch:" + this.live.sessionId)) || {} : {};
      this.qs = (await ctx.storage.get("qs")) || [];   // every question asked: { id, prompt, seconds, startedAt, lesson } (kept until deleted)
      this.qa = {};                                       // qid -> { code: { text, at } }, loaded as needed from "qa:<qid>"
      if (this.live && this.live.ask) await this.loadQA(this.live.ask.id);
      if (this.live && this.live.show) await this.loadQA(this.live.show.qid);
      this.sq = this.live ? (await ctx.storage.get("sq:" + this.live.sessionId)) || [] : [];
      this.act = this.live ? (await ctx.storage.get("act:" + this.live.sessionId)) || {} : {};
      this.sev = this.live ? (await ctx.storage.get("sev:" + this.live.sessionId)) || {} : {}; // code -> pageId -> event name -> first time the sim reported it   // code -> { n, away, since, log }   // questions students sent the teacher this class: { id, code, text, at, reply, replyAt }
      if (this.live) for (const q of this.qs) if (q.sessionId === this.live.sessionId) await this.loadQA(q.id);
      this.liveLesson = this.live ? withPlan((await ctx.storage.get("lesson:" + this.live.lessonId)) || null) : null;
      if (this.live && !Array.isArray(this.live.plan)) this.live.plan = (this.liveLesson && this.liveLesson.plan) || [];
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
      if (p.startsWith("/sim/") && m === "GET") return this.serveSim(p.slice(5));

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

      // the TV page, for networks that block websockets
      if (p === "/api/screen" && m === "GET") return json(this.screenState());

      // questions students can answer while they wait for class to start (nothing private in them)
      if (p === "/api/trivia-s" && m === "GET") {
        const saved = await this.ctx.storage.get("trivia"); const t = saved || { on: true, list: [] }; if (!saved) t.fresh = true; // nothing saved yet: the page falls back to the starter questions
        return json(t.on === false ? { on: false, list: [] } : t);
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
      if (p === "/api/signout-all" && m === "POST") {
        this.stokens = {};
        await this.ctx.storage.put("stokens", {});
        this.broadcast();
        return json({ ok: true });
      }
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
      if (p === "/api/answers" && m === "GET") return json(await this.loadQA(url.searchParams.get("q")));
      if (p === "/api/t" && m === "POST") {
        await this.teacherMessage(await request.json());
        return json(await this.teacherState());
      }
      if (p === "/api/lessons" && m === "GET") return json((await this.ctx.storage.get("lessons")) || []);
      const lm = p.match(/^\/api\/lessons\/([a-z0-9]+)$/);
      if (lm && m === "GET") {
        const l = await this.ctx.storage.get("lesson:" + lm[1]);
        return l ? json(withPlan(l)) : json({ error: "not found" }, 404);
      }
      if (lm && m === "PUT") return this.saveLesson(lm[1], await request.json());
      if (lm && m === "DELETE") return this.deleteLesson(lm[1]);
      if (p === "/api/images" && m === "POST") return this.saveImage(request);

      // sims the teacher uploads (single .html files), shown in lessons from /sim/<id>
      if (p === "/api/sims" && m === "GET") return json(await this.simIndex());
      if (p === "/api/sims" && m === "POST") return this.saveSim(request, null);
      const sm = p.match(/^\/api\/sims\/([a-z0-9]+)$/);
      if (sm && m === "PUT") return this.saveSim(request, sm[1]);
      if (sm && m === "DELETE") return this.deleteSim(sm[1]);

      // waiting-room questions
      if (p === "/api/trivia" && m === "GET") return json((await this.ctx.storage.get("trivia")) || { on: true, list: [] });
      if (p === "/api/trivia" && m === "PUT") {
        const t = cleanTrivia(await request.json());
        await this.ctx.storage.put("trivia", t);
        return json(t);
      }

      // short videos kept in the R2 bucket, played from /video/<id>
      if (p === "/api/videos" && m === "GET") return json({ ready: !!this.env.VIDEOS, videos: (await this.ctx.storage.get("videos")) || [] });
      if (p === "/api/videos" && m === "POST") return this.saveVideo(request);
      const vm = p.match(/^\/api\/videos\/([a-z0-9]+)$/);
      if (vm && m === "PATCH") return this.renameVideo(vm[1], await request.json());
      if (vm && m === "DELETE") return this.deleteVideo(vm[1]);

      // the teacher's private notes, one set for each lesson in each block
      if (p === "/api/past" && m === "GET") return json(await this.pastList());
      const pm = p.match(/^\/api\/past\/([a-z0-9]+)$/i);
      if (pm && m === "GET") { const r = await this.pastClass(pm[1]); return r ? json(r) : json({ error: "not found" }, 404); }
      if (pm && m === "DELETE") {
        await this.ctx.storage.delete("past:" + pm[1]);
        await this.ctx.storage.put("pastIndex", ((await this.ctx.storage.get("pastIndex")) || []).filter((x) => x.id !== pm[1]));
        return json({ ok: true });
      }
      if (p === "/api/notes" && m === "GET") {
        const n = await this.ctx.storage.get(this.notesKey(url.searchParams.get("lesson"), url.searchParams.get("period")));
        return json({ text: n ? n.text : "" });
      }
      if (p === "/api/notes" && m === "PUT") {
        const b = await request.json();
        await this.ctx.storage.put(this.notesKey(b.lesson, b.period), { text: String(b.text || "").slice(0, 20000), updated: Date.now() });
        return json({ ok: true });
      }

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

  // Forgotten passcode: needs the RESET_KEY secret, set in Cloudflare (Worker class-live > Settings > Variables and secrets).
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
    const srcPlan = Array.isArray(lesson.plan) ? lesson.plan : withPlan({ pages: Array.isArray(lesson.pages) ? lesson.pages : [] }).plan;
    lesson = {
      id,
      title: String(lesson.title || "Untitled lesson").slice(0, 200),
      level: lesson.level === "honors" || lesson.level === "enriched" ? lesson.level : "",
      pages: (Array.isArray(lesson.pages) ? lesson.pages : []).map(({ questions, ...pg }) => pg),
      plan: lesson.plan,
      updated: Date.now(),
    };
    lesson.plan = cleanPlan(srcPlan, lesson.pages);
    await this.ctx.storage.put("lesson:" + id, lesson);
    const index = ((await this.ctx.storage.get("lessons")) || []).filter((l) => l.id !== id);
    index.unshift({ id, title: lesson.title, pages: lesson.pages.length, updated: lesson.updated, level: lesson.level, items: lesson.plan.length });
    await this.ctx.storage.put("lessons", index);
    if (this.live && this.live.lessonId === id) {
      this.liveLesson = lesson;
      this.live.plan = cleanPlan(this.live.plan, lesson.pages);
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

  // An uploaded sim file. name comes in the x-name header; a PUT to an existing id replaces the file
  // and keeps the name unless a new one is sent, so lessons that use the sim pick up the new version.
  async saveSim(request, id) {
    const html = await request.text();
    if (new TextEncoder().encode(html).length > MAX_SIM_BYTES) return json({ error: "That file is too large (the limit is about 1.8 MB)." }, 400);
    if (!/<(html|head|body|script|canvas|div)\b/i.test(html)) return json({ error: "That doesn't look like a web page (.html file)." }, 400);
    const index = (await this.ctx.storage.get("sims")) || [];
    const old = id ? index.find((x) => x.id === id) : null;
    if (id && !old) return json({ error: "That sim isn't there any more." }, 404);
    let name = "";
    try { name = decodeURIComponent(request.headers.get("x-name") || ""); } catch { name = request.headers.get("x-name") || ""; }
    name = name.replace(/\.html?$/i, "").replace(/\s+/g, " ").trim().slice(0, 80) || (old ? old.name : "Sim");
    if (old && !request.headers.get("x-name")) name = old.name;
    const sid = id || rid(12);
    const updated = Date.now();
    await this.ctx.storage.put("sim:" + sid, { html, updated });
    const entry = { id: sid, name, size: html.length, updated, ...simManifest(html) };
    await this.ctx.storage.put("sims", [entry, ...index.filter((x) => x.id !== sid)]);
    return json(entry);
  }

  // the sim list; sims uploaded before events were tracked get theirs worked out once, here
  async simIndex() {
    const index = (await this.ctx.storage.get("sims")) || [];
    let changed = false;
    for (const e of index) {
      if (e.events) continue;
      const rec = await this.ctx.storage.get("sim:" + e.id);
      Object.assign(e, rec ? simManifest(rec.html) : { events: [], commands: [] });
      changed = true;
    }
    if (changed) await this.ctx.storage.put("sims", index);
    return index;
  }

  async saveVideo(request) {
    if (!this.env.VIDEOS) return json({ error: "The video storage isn't connected yet (the class-live-videos bucket is missing)." }, 503);
    const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!VIDEO_TYPES[type]) return json({ error: "Use an .mp4 file (.webm and .mov also work)." }, 400);
    const len = Number(request.headers.get("content-length") || 0);
    if (!len || !request.body) return json({ error: "That upload didn't say how big it is. Try again." }, 411);
    if (len > MAX_VIDEO_BYTES) return json({ error: "That video is " + Math.round(len / 1e6) + " MB. The limit is " + Math.round(MAX_VIDEO_BYTES / 1e6) + " MB. A short clip squeezed to 720p is usually 10 to 30 MB." }, 413);
    let name = "";
    try { name = decodeURIComponent(request.headers.get("x-name") || ""); } catch { name = request.headers.get("x-name") || ""; }
    name = name.replace(/\.(mp4|webm|mov|m4v)$/i, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Video";
    const id = rid(12);
    await this.env.VIDEOS.put("v/" + id, request.body, { httpMetadata: { contentType: type } });
    const entry = { id, name, size: len, type, updated: Date.now() };
    await this.ctx.storage.put("videos", [entry, ...((await this.ctx.storage.get("videos")) || [])]);
    return json(entry);
  }

  async renameVideo(id, body) {
    const list = (await this.ctx.storage.get("videos")) || [];
    const v = list.find((x) => x.id === id);
    if (!v) return json({ error: "That video isn't there any more." }, 404);
    v.name = String((body && body.name) || "").replace(/\s+/g, " ").trim().slice(0, 80) || v.name;
    await this.ctx.storage.put("videos", list);
    return json(v);
  }

  async deleteVideo(id) {
    if (this.env.VIDEOS) await this.env.VIDEOS.delete("v/" + id);
    await this.ctx.storage.put("videos", ((await this.ctx.storage.get("videos")) || []).filter((x) => x.id !== id));
    return json({ ok: true });
  }

  async deleteSim(id) {
    await this.ctx.storage.delete("sim:" + id);
    await this.ctx.storage.put("sims", ((await this.ctx.storage.get("sims")) || []).filter((x) => x.id !== id));
    return json({ ok: true });
  }

  // Serves the page with the Class Live freeze script added at the top, so Pause and
  // pushed questions freeze it. A sim that already has its own Class Live code is left as it is.
  async serveSim(id) {
    const sim = await this.ctx.storage.get("sim:" + id.replace(/[^a-z0-9]/g, ""));
    if (!sim) return new Response("That sim was not found.", { status: 404 });
    let html = sim.html;
    if (!/classlive/i.test(html)) {
      const tag = "<script>" + FREEZE_JS + "</script>";
      let at = 0;
      let m = html.match(/<head[^>]*>/i) || html.match(/<html[^>]*>/i);
      if (m) at = m.index + m[0].length;
      else { m = html.match(/^\s*<!doctype[^>]*>/i); if (m) at = m[0].length; }
      html = html.slice(0, at) + tag + html.slice(at);
    }
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  }

  async getImage(id) {
    const img = await this.ctx.storage.get("img:" + id.replace(/[^a-z0-9]/g, ""));
    if (!img) return new Response("not found", { status: 404 });
    return new Response(img.data, {
      headers: { "content-type": img.type, "cache-control": "public, max-age=31536000, immutable" },
    });
  }

  notesKey(lesson, period) {
    const c = (x) => String(x || "none").replace(/[^a-z0-9]/gi, "").slice(0, 20) || "none";
    return "notes:" + c(lesson) + ":" + c(period);
  }

  // ---------------------------------------------------------------- live session
  pages() {
    return (this.liveLesson && this.liveLesson.pages) || [];
  }

  // a fresh "live" record: a class (keeping the running one's start time and block), with or without a lesson
  newLive(pd, lesson, from, keep) {
    const now = Date.now();
    return { sessionId: rid(8), classId: keep ? keep.classId || keep.sessionId : rid(8), lessonId: lesson ? lesson.id : "",
      unlocked: from, from, revealed: {}, startedAt: keep ? keep.startedAt : now, lessonAt: now,
      periodId: pd ? pd.id : null, periodName: pd ? pd.name : "",
      autoEndAt: keep ? keep.autoEndAt : pd ? autoEndTime(pd.name, now) : null,
      // this lesson's own copy of the plan: changed freely during class; kept in the lesson only if the teacher says so
      plan: lesson ? JSON.parse(JSON.stringify(lesson.plan || [])) : [], item: "", planChanged: false };
  }
  // the running lesson ends: keep plan changes if asked, record it in Past lessons, clear its votes
  async finishLesson(keepPlan) {
    if (!this.live) return;
    if (keepPlan && this.live.planChanged && this.live.lessonId) {
      const l = await this.ctx.storage.get("lesson:" + this.live.lessonId);
      if (l) await this.saveLesson(this.live.lessonId, { ...withPlan(l), plan: this.live.plan, pages: withPlan(l).pages, live: undefined });
    }
    await this.archiveClass();
    await this.ctx.storage.delete(["votes:" + this.live.sessionId, "watch:" + this.live.sessionId, "sev:" + this.live.sessionId]);
    this.watch = {};
    this.sev = {};
    this.liveLesson = null;
    this.votes = {};
  }

  async teacherMessage(msg) {
    switch (msg.t) {
      // start the class for a block: students in that block are in class (waiting screen) until a lesson starts
      case "classStart": {
        await this.finishLesson(false);
        const pd = this.roster.periods.find((x) => x.id === msg.periodId) || null;
        if (this.roster.periods.length && !pd) return;
        this.live = this.newLive(pd, null, 0, null);
        this.sq = []; this.act = {}; this.sev = {};
        await this.ctx.storage.put("live", this.live);
        await this.setAlarms();
        break;
      }
      // start a lesson: inside the running class if there is one (the class keeps going), else a class starts with it
      case "start": {
        const lesson = withPlan(await this.ctx.storage.get("lesson:" + msg.lessonId));
        if (!lesson) return;
        const keep = this.live;
        await this.finishLesson(!!msg.keepPlan);
        let pd;
        if (keep) pd = keep.periodId ? { id: keep.periodId, name: keep.periodName } : null;
        else {
          // each block is started on its own: only that block's students move into the lesson
          pd = this.roster.periods.find((x) => x.id === msg.periodId) || null;
          if (this.roster.periods.length && !pd) return;
        }
        const from = Math.max(0, Math.min(Math.floor(Number(msg.from)) || 0, lesson.pages.length - 1)); // the page this lesson starts on
        this.live = this.newLive(pd, lesson, from, keep);
        this.liveLesson = lesson;
        if (!keep) { this.sq = []; this.act = {}; }
        this.sev = {};
        await this.ctx.storage.put("live", this.live);
        // questions from students and who left the window carry on through the class
        await this.ctx.storage.put("sq:" + this.live.sessionId, this.sq);
        await this.ctx.storage.put("act:" + this.live.sessionId, this.act);
        await this.setAlarms();
        break;
      }
      // the lesson ends; the class keeps running and students go back to the waiting screen
      case "endLesson": {
        if (!this.live || !this.live.lessonId) return;
        const keep = this.live;
        await this.finishLesson(!!msg.keepPlan);
        this.live = this.newLive(keep.periodId ? { id: keep.periodId, name: keep.periodName } : null, null, 0, keep);
        await this.ctx.storage.put("live", this.live);
        await this.ctx.storage.put("sq:" + this.live.sessionId, this.sq);
        await this.ctx.storage.put("act:" + this.live.sessionId, this.act);
        await this.setAlarms();
        break;
      }
      case "end": {
        await this.finishLesson(!!msg.keepPlan);
        this.live = null;
        await this.ctx.storage.delete("live");
        await this.setAlarms();
        break;
      }
      case "unlock": {
        if (!this.live) return;
        const n = Math.max(this.live.from || 0, Math.min(Number(msg.to) || 0, this.pages().length - 1));
        this.live.unlocked = n;
        await this.ctx.storage.put("live", this.live);
        break;
      }
      // the plan during class: change it, or move to an item (which can send students to its page)
      case "planSet": {
        if (!this.live) return;
        this.live.plan = cleanPlan(msg.plan, this.pages());
        this.live.planChanged = true;
        await this.ctx.storage.put("live", this.live);
        break;
      }
      case "planGo": {
        if (!this.live) return;
        const it = (this.live.plan || []).find((x) => x.id === msg.itemId);
        if (!it) return;
        this.live.item = it.id;
        const idx = it.pageId ? this.pages().findIndex((p) => p.id === it.pageId) : -1;
        if (idx >= 0) {
          this.live.unlocked = Math.max(this.live.unlocked, idx);
          this.live.goto = { page: idx, n: ((this.live.goto && this.live.goto.n) || 0) + 1 };
          this.live.screenPage = idx;
        }
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
      // pause: covers every student's screen and asks sims that know how to freeze
      case "pause": {
        if (!this.live) return;
        this.live.paused = !!msg.on;
        await this.ctx.storage.put("live", this.live);
        break;
      }
      // a written question pushed to every screen, with a time limit. It can have several parts,
      // each with its own timer: part 1 goes out now, "askNext" sends the next one.
      case "ask": {
        if (!this.live) return;
        let parts = Array.isArray(msg.parts) ? msg.parts : [{ prompt: msg.prompt, seconds: msg.seconds }];
        parts = parts.slice(0, 8).map((p) => ({
          prompt: String((p && p.prompt) || "").trim().slice(0, 2000),
          seconds: Math.max(10, Math.min(Number(p && p.seconds) || 120, 3600)),
          // a picture (an uploaded image) or an animation (an uploaded sim) shown with the question
          imageId: /^[a-z0-9]{4,24}$/.test((p && p.imageId) || "") ? p.imageId : "",
          sim: /^\/(sim|video)\/[a-z0-9]+$/.test((p && p.sim) || "") ? p.sim : "", // an uploaded sim, or an uploaded video
        })).filter((p) => p.prompt);
        if (!parts.length) return;
        if (msg.preparedId) (this.live.sent ||= {})[String(msg.preparedId).replace(/[^a-z0-9]/gi, "").slice(0, 20)] = Date.now(); // for the "asked" mark
        this.live.askSet = { setId: rid(6), parts, i: 0, allowSim: !!msg.allowSim };
        await this.startPart(0);
        break;
      }
      case "askNext": {
        const set = this.live && this.live.askSet;
        if (!set || set.i + 1 >= set.parts.length) return;
        await this.startPart(set.i + 1);
        break;
      }
      // stop the answering so the class can talk: students see a pause screen, the TV goes back to the page
      case "askPause": {
        const a = this.live && this.live.ask;
        if (!a) return;
        const now = Date.now();
        if (msg.on && !a.paused) { a.paused = true; a.pausedAt = now; }
        else if (!msg.on && a.paused) {
          if (a.endsAt > a.pausedAt) a.endsAt += now - a.pausedAt; // the time left is the same as when it was paused
          a.paused = false; a.pausedAt = 0;
        }
        else return;
        await this.ctx.storage.put("live", this.live);
        break;
      }
      case "askMore": {
        const a = this.live && this.live.ask;
        if (!a || a.paused) return;
        const now = Date.now();
        const sec = Math.max(-600, Math.min(Number(msg.seconds) || 30, 600));
        // adding time counts from now if time had run out; taking time away never goes below 5 seconds left
        a.endsAt = sec > 0 ? Math.max(a.endsAt, now) + sec * 1000 : Math.max(now + 5000, a.endsAt + sec * 1000);
        await this.ctx.storage.put("live", this.live);
        break;
      }
      // more or less time on a question that runs on its own: applies to every student's clock for that question
      case "spTime": {
        if (!this.live) return;
        const qid = String(msg.qid || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
        if (!qid) return;
        const ex = (this.live.spExtra ||= {});
        ex[qid] = Math.max(-3600, Math.min((ex[qid] || 0) + (Number(msg.seconds) || 0), 3600));
        await this.ctx.storage.put("live", this.live);
        break;
      }
      case "askEnd": {
        const a = this.live && this.live.ask;
        if (!a || a.paused) return;
        a.endsAt = Math.min(a.endsAt, Date.now());
        await this.ctx.storage.put("live", this.live);
        break;
      }
      case "askClose": {
        if (!this.live || !this.live.ask) return;
        this.live.ask = null;
        this.live.askSet = null;
        await this.ctx.storage.put("live", this.live);
        break;
      }
      // answers picked to show (no names) on the TV and students' screens
      case "show": {
        if (!this.live) return;
        const qid = String(msg.qid || "");
        if (!this.qs.some((q) => q.id === qid)) return;
        await this.loadQA(qid);
        let sh = this.live.show && this.live.show.qid === qid ? this.live.show : { qid, codes: [] };
        const code = String(msg.code || "");
        sh.codes = sh.codes.filter((c) => c !== code);
        if (msg.on && this.qa[qid][code]) sh.codes.push(code);
        this.live.show = sh.codes.length ? sh : null;
        await this.ctx.storage.put("live", this.live);
        break;
      }
      case "hideAll": {
        if (!this.live || !this.live.show) return;
        this.live.show = null;
        await this.ctx.storage.put("live", this.live);
        break;
      }
      // a reply to one student's question: only that student sees it
      case "sqReply": {
        if (!this.live) return;
        const q = this.sq.find((x) => x.id === String(msg.id || ""));
        const text = String(msg.text || "").trim().slice(0, 1000);
        if (!q || !text) return;
        q.reply = text; q.replyAt = Date.now();
        await this.ctx.storage.put("sq:" + this.live.sessionId, this.sq);
        this.sendToCode(q.code);
        break;
      }
      // feedback on one student's answer: a comment and/or a thumbs up, shown to that student right away
      case "feedback": {
        const qid = String(msg.qid || "");
        if (!this.qs.some((q) => q.id === qid)) return;
        await this.loadQA(qid);
        const code = String(msg.code || "");
        const a = this.qa[qid][code];
        if (!a) return;
        const text = String(msg.text ?? (a.fb && a.fb.text) ?? "").trim().slice(0, 1000);
        const thumb = msg.thumb === undefined ? !!(a.fb && a.fb.thumb) : !!msg.thumb;
        if (text || thumb) a.fb = { text, thumb, at: Date.now() }; else delete a.fb;
        await this.ctx.storage.put("qa:" + qid, this.qa[qid]);
        this.sendToCode(code);
        break;
      }
      case "qDelete": {
        const qid = String(msg.qid || "");
        this.qs = this.qs.filter((q) => q.id !== qid);
        delete this.qa[qid];
        await this.ctx.storage.put("qs", this.qs);
        await this.ctx.storage.delete("qa:" + qid);
        if (this.live) {
          if (this.live.ask && this.live.ask.id === qid) this.live.ask = null;
          if (this.live.show && this.live.show.qid === qid) this.live.show = null;
          await this.ctx.storage.put("live", this.live);
        }
        break;
      }
      // the page the TV shows follows the page the teacher is looking at
      case "screenPage": {
        if (!this.live) return;
        const n = Math.max(0, Math.min(Number(msg.n) || 0, this.live.unlocked));
        if (this.live.screenPage === n) return;
        this.live.screenPage = n;
        await this.ctx.storage.put("live", this.live);
        break;
      }
      default:
        return; // "refresh" and unknown messages change nothing
    }
    if (msg.t.startsWith("ask")) await this.setAlarms(); // the running question's time may have changed
    this.broadcast();
  }

  async startPart(i) {
    const set = this.live.askSet;
    const p = set.parts[i];
    const now = Date.now();
    const id = rid(8);
    set.i = i;
    this.live.ask = { id, prompt: p.prompt, seconds: p.seconds, startedAt: now, endsAt: now + p.seconds * 1000,
      part: i + 1, parts: set.parts.length, allowSim: !!set.allowSim, paused: false, pausedAt: 0,
      imageId: p.imageId || "", sim: p.sim || "" };
    this.live.show = null; // a new question takes the middle of the screen
    this.qa[id] = {};
    this.qs.unshift({ id, prompt: p.prompt, seconds: p.seconds, startedAt: now, lesson: this.liveLesson ? this.liveLesson.title : "",
      block: this.live.periodName || "", part: i + 1, parts: set.parts.length, setId: set.setId, sessionId: this.live.sessionId });
    if (this.qs.length > 500) for (const old of this.qs.splice(500)) await this.ctx.storage.delete("qa:" + old.id);
    await this.ctx.storage.put("qs", this.qs);
    await this.ctx.storage.put("live", this.live);
  }

  // is this student in the block that is running? (no class running, or a class with no block set, counts as yes)
  inBlock(stu) {
    return !this.live || !this.live.periodId || (!!stu && stu.periodId === this.live.periodId);
  }

  // A student's written answer. Saved as they type; accepted until time runs out (plus a few seconds for slow networks).
  async saveAsk(msg, stu) {
    const a = this.live && this.live.ask;
    if (!stu || !a || msg.qid !== a.id || !this.inBlock(stu)) return;
    if (!a.paused && Date.now() > a.endsAt + 5000) return;
    await this.loadQA(a.id);
    // typing again after submitting means the answer is being changed, so it is not "submitted" until they press Submit again
    this.qa[a.id][stu.name] = { text: String(msg.text || "").slice(0, 5000), at: Date.now(), done: !!msg.submit };
    await this.ctx.storage.put("qa:" + a.id, this.qa[a.id]);
    // if this student's answer is on display, the screens need the new wording
    const sh = this.live.show;
    this.broadcast({ teachersOnly: !(sh && sh.qid === a.id && sh.codes.includes(stu.name)) });
  }

  // Questions that run on their own (mode "student") are answered at each student's own pace, in a side panel.
  // Each part gets its own saved question (so it shows in the Questions list) the first time anyone answers it.
  spId(pageId, qid, idx) {
    return "s" + [this.live.sessionId, pageId, qid, idx].join("_").replace(/[^a-z0-9_]/gi, "").slice(0, 70);
  }
  spQuestions() {
    const out = [];
    if (!this.live) return out;
    for (const pg of this.pages().slice(0, this.live.unlocked + 1)) {
      for (const q of this.pageQs(pg)) if (q && q.mode === "student" && Array.isArray(q.parts) && q.parts.length) out.push({ pg, q });
    }
    return out;
  }
  // questions that belong to a page: those in plan items that go to it
  pageQs(pg) {
    const out = [];
    for (const it of (this.live && this.live.plan) || []) if (it.pageId === pg.id) out.push(...(it.questions || []));
    return out;
  }
  async saveSp(msg, stu, submit, sid) {
    if (!stu || !this.live || !this.inBlock(stu)) return;
    const hit = this.spQuestions().find((x) => x.pg.id === msg.pageId && x.q.id === msg.qid);
    const idx = Number(msg.idx);
    if (!hit || !Number.isInteger(idx) || idx < 0 || idx >= hit.q.parts.length) return;
    const prompt = String(hit.q.parts[idx].prompt || "").trim();
    if (!prompt) return;
    const id = this.spId(hit.pg.id, hit.q.id, idx);
    await this.loadQA(id);
    const cur = this.qa[id][stu.name];
    if (cur && cur.done) return; // submitted answers are final
    if (!this.qs.some((q) => q.id === id)) {
      this.qs.unshift({ id, prompt: prompt.slice(0, 2000), seconds: 0, startedAt: Date.now(), lesson: this.liveLesson ? this.liveLesson.title : "",
        block: this.live.periodName || "", part: idx + 1, parts: hit.q.parts.length, setId: "", sp: true, sessionId: this.live.sessionId });
      if (this.qs.length > 500) for (const old of this.qs.splice(500)) await this.ctx.storage.delete("qa:" + old.id);
      await this.ctx.storage.put("qs", this.qs);
    }
    this.qa[id][stu.name] = { text: String(msg.text || "").slice(0, 5000), at: Date.now(), done: !!submit };
    await this.ctx.storage.put("qa:" + id, this.qa[id]);
    this.broadcast({ teachersOnly: true });
    if (submit) this.sendToStudent(sid);
  }
  // this student's saved answers to the self-paced questions: "questionId.partIndex" -> { text, done, at }
  spMine(stu) {
    const out = {};
    if (!stu) return out;
    for (const { pg, q } of this.spQuestions()) {
      q.parts.forEach((_, i) => {
        const a = (this.qa[this.spId(pg.id, q.id, i)] || {})[stu.name];
        if (a) out[q.id + "." + i] = { text: a.text, done: !!a.done, at: a.at };
      });
    }
    return out;
  }
  // how many students have answered / submitted each part (for the teacher)
  // a student's clock on a self-starting question began: keep the latest start, so the teacher knows when the last clock runs out
  async noteSpStart(msg, stu) {
    if (!stu || !this.live || !this.inBlock(stu)) return;
    const hit = this.spQuestions().find((x) => x.pg.id === msg.pageId && x.q.id === msg.qid);
    const idx = Number(msg.idx);
    if (!hit || !Number.isInteger(idx) || idx < 0 || idx >= hit.q.parts.length) return;
    const id = this.spId(hit.pg.id, hit.q.id, idx);
    const at = Math.min(Number(msg.at) || Date.now(), Date.now());
    const last = (this.live.spLast ||= {});
    if ((last[id] || 0) >= at) return;
    last[id] = at;
    await this.ctx.storage.put("live", this.live);
    this.broadcast({ teachersOnly: true });
  }
  // a sim on a lesson page reported an event (e.g. "level2Done"): remember it for the teacher's progress table
  async noteSimEvent(msg, stu) {
    if (!stu || !this.live || !this.inBlock(stu)) return;
    const name = String(msg.name || "");
    if (!/^[A-Za-z][\w-]{0,40}$/.test(name) || !this.pages().some((pg) => pg.id === msg.pageId)) return;
    const mine = ((this.sev ||= {})[stu.name] ||= {});
    const pg = (mine[msg.pageId] ||= {});
    if (pg[name] || Object.keys(pg).length >= 40) return;
    pg[name] = Date.now();
    await this.ctx.storage.put("sev:" + this.live.sessionId, this.sev);
    this.broadcast({ teachersOnly: true });
  }
  spCounts() {
    const out = {};
    for (const { pg, q } of this.spQuestions()) {
      q.parts.forEach((_, i) => {
        const a = this.qa[this.spId(pg.id, q.id, i)] || {};
        const v = Object.values(a);
        const sid = this.spId(pg.id, q.id, i), last = (this.live.spLast || {})[sid] || 0;
        out[q.id + "." + i] = { n: v.length, done: v.filter((x) => x.done).length, qid: sid,
          // when the last student's clock on this part runs out
          ends: last ? last + (Number(q.parts[i].min) || 3) * 60000 + ((this.live.spExtra || {})[q.id] || 0) * 1000 : 0,
          prompt: String(q.parts[i].prompt || "").replace(/\*+/g, "").slice(0, 120), part: i + 1, parts: q.parts.length };
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- past classes
  // When a class ends, keep a record: the lesson, the block, when, poll results and the questions students sent.
  // Written answers are already kept with each question; they are found again by the class's session.
  async archiveClass() {
    const L = this.live;
    if (!L || !this.liveLesson) return;
    const polls = [];
    this.pages().forEach((pg, i) => {
      const poll = (pg.blocks || []).find((b) => b.type === "poll");
      if (!poll || i > L.unlocked) return;
      const counts = (poll.options || []).map(() => 0);
      const v = this.votes[pg.id] || {};
      for (const c of Object.values(v)) if (c < counts.length) counts[c]++;
      polls.push({ page: i + 1, question: poll.question || "", options: poll.options || [], counts, total: Object.keys(v).length });
    });
    const rec = { id: L.sessionId, lessonId: L.lessonId, title: this.liveLesson.title || "", block: L.periodName || "",
      startedAt: L.lessonAt || L.startedAt, endedAt: Date.now(), pages: L.unlocked + 1, polls, sq: this.sq || [], plan: (L.plan || []).map((x) => ({ title: x.title, pageId: x.pageId, questions: (x.questions || []).length })),
      act: Object.fromEntries(Object.entries(this.act || {}).map(([c, a]) => [c, { ...a, away: a.away + (a.since ? Date.now() - a.since : 0), since: 0 }])) };
    // sim progress per page: the events each sim says it reports (its own list first), and who reported which
    const sims = await this.simIndex().catch(() => []);
    rec.sims = [];
    this.pages().forEach((pg, i) => {
      const ids = (pg.blocks || []).map((b) => b && b.type === "sim" && ((b.url || "").match(/^\/sim\/([a-z0-9]+)$/) || [])[1]).filter(Boolean);
      const got = Object.fromEntries(Object.entries(this.sev || {}).filter(([, v]) => v[pg.id]).map(([c, v]) => [c, v[pg.id]]));
      if (!ids.length && !Object.keys(got).length) return;
      const evs = [];
      for (const id of ids) { const sm = sims.find((x) => x.id === id); for (const e of (sm && sm.events) || []) if (!evs.some((x) => x.name === e.name)) evs.push({ name: e.name, says: e.says }); }
      for (const v of Object.values(got)) for (const n of Object.keys(v)) if (!evs.some((x) => x.name === n)) evs.push({ name: n, says: "" });
      if (!evs.length) return;
      rec.sims.push({ page: i + 1, sim: ids.map((id) => (sims.find((x) => x.id === id) || {}).name || "").filter(Boolean).join(", "), events: evs, got });
    });
    await this.ctx.storage.put("past:" + rec.id, rec);
    const idx = ((await this.ctx.storage.get("pastIndex")) || []).filter((x) => x.id !== rec.id);
    idx.unshift({ id: rec.id, title: rec.title, block: rec.block, startedAt: rec.startedAt, endedAt: rec.endedAt });
    if (idx.length > 400) for (const old of idx.splice(400)) await this.ctx.storage.delete("past:" + old.id);
    await this.ctx.storage.put("pastIndex", idx);
  }
  // Questions asked in classes that ended without a record (before Past lessons existed), grouped by day, block and lesson.
  async loosePast() {
    const idx = (await this.ctx.storage.get("pastIndex")) || [];
    const ids = new Set(idx.map((x) => x.id));
    const covered = [];
    for (const x of idx) { const r = await this.ctx.storage.get("past:" + x.id); if (r) covered.push(r); }
    const inRec = (q) => covered.some((r) => q.sessionId ? q.sessionId === r.id
      : q.block === r.block && q.lesson === r.title && q.startedAt >= r.startedAt && q.startedAt <= r.endedAt);
    const groups = new Map();
    for (const q of this.qs) {
      if (this.live && (q.sessionId === this.live.sessionId || (!q.sessionId && q.startedAt >= this.live.startedAt))) continue; // the class running now
      if ((q.sessionId && ids.has(q.sessionId)) || inRec(q)) continue;
      const p = zoneParts(q.startedAt);
      const key = p.y + "-" + p.mo + "-" + p.d + "|" + (q.block || "") + "|" + (q.lesson || "");
      let h = 5381; for (const ch of key) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
      const id = "g" + h.toString(36);
      const g = groups.get(id) || { id, title: q.lesson || "", block: q.block || "", startedAt: q.startedAt, endedAt: q.startedAt, qs: [], loose: true };
      g.startedAt = Math.min(g.startedAt, q.startedAt); g.endedAt = Math.max(g.endedAt, q.startedAt + (q.seconds || 0) * 1000);
      g.qs.push(q);
      groups.set(id, g);
    }
    return [...groups.values()];
  }
  async pastList() {
    const idx = (await this.ctx.storage.get("pastIndex")) || [];
    const loose = (await this.loosePast()).map(({ qs, ...g }) => g);
    return [...idx, ...loose].sort((a, b) => b.startedAt - a.startedAt);
  }
  async pastClass(id) {
    id = String(id).replace(/[^a-z0-9]/gi, "");
    if (id[0] === "g") {
      const g = (await this.loosePast()).find((x) => x.id === id);
      if (!g) return null;
      const questions = [];
      for (const q of g.qs.slice().reverse()) questions.push({ ...q, answers: await this.loadQA(q.id) });
      return { id, title: g.title, block: g.block, startedAt: g.startedAt, endedAt: g.endedAt, pages: null, polls: [], sq: [], act: {}, loose: true, questions };
    }
    const rec = await this.ctx.storage.get("past:" + id);
    if (!rec) return null;
    // questions from this class: by session, or (older ones) by block and time
    const qs = this.qs.filter((q) => q.sessionId ? q.sessionId === rec.id
      : q.block === rec.block && q.lesson === rec.title && q.startedAt >= rec.startedAt && q.startedAt <= rec.endedAt);
    const questions = [];
    for (const q of qs.slice().reverse()) questions.push({ ...q, answers: await this.loadQA(q.id) });
    return { ...rec, questions };
  }

  // When a student leaves the Class Live window (another tab or window, or the screen goes off) and comes back.
  async saveAct(msg, stu) {
    if (!stu || !this.live || !this.inBlock(stu)) return;
    const now = Date.now();
    const a = (this.act ||= {})[stu.name] ||= { n: 0, away: 0, since: 0, log: [] };
    if (msg.kind === "away" && !a.since) { a.since = now; a.n++; a.log.push([now, 0]); }
    else if (msg.kind === "back" && a.since) {
      a.away += now - a.since;
      const last = a.log[a.log.length - 1]; if (last && !last[1]) last[1] = now;
      a.since = 0;
    } else return;
    if (a.log.length > 60) a.log.splice(0, a.log.length - 60);
    await this.ctx.storage.put("act:" + this.live.sessionId, this.act);
    this.broadcast({ teachersOnly: true });
  }

  // A question a student sends the teacher. Only while their block's class is running.
  async saveSq(msg, stu) {
    if (!stu || !this.live || !this.inBlock(stu)) return;
    const text = String(msg.text || "").trim().slice(0, 1000);
    if (!text) return;
    this.sq.push({ id: rid(8), code: stu.name, text, at: Date.now(), reply: "", replyAt: 0 });
    if (this.sq.length > 300) this.sq.splice(0, this.sq.length - 300);
    await this.ctx.storage.put("sq:" + this.live.sessionId, this.sq);
    this.broadcast({ teachersOnly: true });
    this.sendToCode(stu.name);
  }
  // feedback this student has had in this class, newest last
  myFeedback(stu) {
    const out = [];
    for (const q of this.qs) {
      if (q.sessionId !== this.live.sessionId) continue;
      const a = (this.qa[q.id] || {})[stu.name];
      if (a && a.fb) out.push({ qid: q.id, prompt: q.prompt, part: q.part || 1, parts: q.parts || 1, text: a.text, fb: a.fb });
    }
    return out.sort((x, y) => x.fb.at - y.fb.at);
  }
  // push fresh state to every open page of one student
  sendToCode(code) {
    for (const ws of this.ctx.getWebSockets("student")) {
      const a = ws.deserializeAttachment() || {};
      const stu = a.sid && this.studentFrom(a.stoken);
      if (stu && stu.name === code) { try { ws.send(JSON.stringify({ t: "state", state: this.studentState(a.sid, stu) })); } catch {} }
    }
  }

  async loadQA(qid) {
    if (!qid) return {};
    if (!this.qa[qid]) this.qa[qid] = (await this.ctx.storage.get("qa:" + qid)) || {};
    return this.qa[qid];
  }

  // what everyone in the room may see: the question and the picked answers, never names
  shared() {
    const L = this.live;
    if (!L) return { paused: false, qpaused: false, ask: null, show: null };
    const sh = L.show;
    const q = sh && this.qs.find((x) => x.id === sh.qid);
    const qa = sh ? this.qa[sh.qid] || {} : {};
    const a = L.ask, qp = !!(a && a.paused);
    return {
      paused: !!L.paused,
      qpaused: qp, // the question is paused: students get a pause screen, the TV shows the page
      ask: a && !qp ? { id: a.id, prompt: a.prompt, endsAt: a.endsAt, part: a.part || 1, parts: a.parts || 1, allowSim: !!a.allowSim, imageId: a.imageId || "", sim: a.sim || "" } : null,
      show: q ? { qid: sh.qid, prompt: q.prompt, answers: sh.codes.filter((c) => qa[c]).map((c) => qa[c].text) } : null,
    };
  }

  // the TV (iPad) page: what the teacher is looking at, poll results when shown, no names, no controls
  screenState() {
    const base = { now: Date.now(), ...this.shared() };
    if (!this.live || !this.liveLesson) return { ...base, live: false };
    const pages = this.pages();
    const n = Math.min(this.live.screenPage ?? this.live.unlocked, this.live.unlocked, pages.length - 1);
    const pg = pages[n];
    let results = null;
    const poll = pg && (pg.blocks || []).find((b) => b.type === "poll");
    if (poll && this.live.revealed[pg.id]) {
      const counts = (poll.options || []).map(() => 0);
      const v = this.votes[pg.id] || {};
      for (const c of Object.values(v)) if (c < counts.length) counts[c]++;
      results = { counts, total: Object.keys(v).length };
    }
    return { ...base, live: true, title: this.liveLesson.title, page: pg, pageNum: n, results };
  }

  async studentMessage(sid, msg, stu) {
    if (msg.t === "answer") return this.saveAnswer(msg, stu);
    if (msg.t === "work") return this.saveWork(msg, stu);
    if (msg.t === "spStart") return this.noteSpStart(msg, stu);
    if (msg.t === "simEv") return this.noteSimEvent(msg, stu);
    if (msg.t === "askAnswer") return this.saveAsk(msg, stu);
    if (msg.t === "askSubmit") return this.saveAsk({ ...msg, submit: true }, stu);
    if (msg.t === "sqSend") return this.saveSq(msg, stu);
    if (msg.t === "act") return this.saveAct(msg, stu);
    if (msg.t === "spAnswer") return this.saveSp(msg, stu, false, sid);
    if (msg.t === "spSubmit") return this.saveSp(msg, stu, true, sid);
    if (msg.t === "away") {
      if (!stu) return;
      this.away ||= {};
      const per = (this.away[stu.periodId] ||= {});
      const a = (per[stu.id] ||= { name: stu.name, away: false, why: "", since: 0, count: 0, ms: 0 });
      const now = Date.now(), goingAway = !!msg.away;
      if (goingAway && !a.away) { a.count++; a.since = now; }
      if (!goingAway && a.away) a.ms += now - a.since;
      a.away = goingAway; a.why = goingAway ? String(msg.why || "").slice(0, 40) : a.why;
      if (this.live && this.inBlock(stu)) {
        // live lesson: time each student spends with the Class Live tab hidden (students are not told)
        const w = (this.watch[stu.name] ||= { away: false, since: 0, count: 0, ms: 0 });
        if (goingAway && !w.away) { w.count++; w.since = now; }
        if (!goingAway && w.away) w.ms += now - w.since;
        w.away = goingAway;
        await this.ctx.storage.put("watch:" + this.live.sessionId, this.watch);
      }
      this.broadcast({ teachersOnly: true });
      return;
    }
    if (msg.t !== "vote" || !this.live || !this.inBlock(stu)) return;
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
    const inb = this.inBlock(stu);
    const sh = inb ? this.shared() : { paused: false, qpaused: false, ask: null, show: null };
    const a = sh.ask;
    const mine = a && stu && this.qa[a.id] && this.qa[a.id][stu.name];
    if (a) { a.mine = mine ? mine.text : ""; a.done = !!(mine && mine.done); }
    return { ...this.lessonState(sid, inb), now: Date.now(), ...sh, sky: this.sky, signedIn: !!stu, me: stu ? stu.name : null, q: this.studentQuestion(stu), zodiac: this.zodiac,
      spMine: inb ? this.spMine(stu) : {},
      spExtra: inb && this.live ? this.live.spExtra || {} : {},
      myFb: inb && stu && this.live ? this.myFeedback(stu) : [],
      myQs: inb && stu && this.live ? this.sq.filter((x) => x.code === stu.name).slice(-20).map((x) => ({ id: x.id, text: x.text, reply: x.reply, at: x.at })) : [] };
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
    await this.setAlarms();
  }

  // One alarm serves both the sky question timer and the automatic end of class.
  async setAlarms() {
    const t = [];
    if (this.run && this.run.endsAt !== null && !this.runClosed()) t.push(this.run.endsAt);
    if (this.live && this.live.autoEndAt) t.push(this.live.autoEndAt);
    const a = this.live && this.live.ask;
    if (a && !a.paused) t.push(a.endsAt + ASK_GRACE); // close the question once its time is up
    if (t.length) await this.ctx.storage.setAlarm(Math.min(...t));
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
    // a sent question's time ran out: go on to its next part, or close it (after a moment for the last answers to save)
    const a = this.live && this.live.ask;
    if (a && !a.paused && Date.now() >= a.endsAt + ASK_GRACE - 1000) {
      const set = this.live.askSet;
      if (set && set.i + 1 < set.parts.length) await this.startPart(set.i + 1);
      else { this.live.ask = null; this.live.askSet = null; await this.ctx.storage.put("live", this.live); }
    }
    if (this.live && this.live.autoEndAt && Date.now() >= this.live.autoEndAt - 1000) {
      await this.teacherMessage({ t: "end" });
    }
    await this.setAlarms();
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

  lessonState(sid, inBlock = true) {
    if (!this.live || !this.liveLesson || !inBlock) return { live: false, inClass: !!this.live && inBlock };
    const unlocked = this.live.unlocked;
    // students only get the questions that run on their own; the ones the teacher sends stay private until sent
    const pages = this.pages().slice(0, unlocked + 1).map((pg) => {
      const pq = this.pageQs(pg);
      if (!pq.length) return pg;
      const word = (v) => (/^[A-Za-z0-9_-]{1,40}$/.test(v || "") ? v : "");
      const qs = pq.filter((q) => q && q.mode === "student" && Array.isArray(q.parts)).map((q) => ({
        id: q.id, mode: "student",
        trigger: q.trigger && q.trigger.type === "after"
          ? { type: "after", afterId: word(q.trigger.afterId), delay: Math.max(0, Math.min(Number(q.trigger.delay) || 0, 600)) }
          : { type: "sim", event: word(q.trigger && q.trigger.event) },
        command: word(q.command),
        noSim: !!q.noSim,
        parts: q.parts.slice(0, 8).map((p) => ({ prompt: String((p && p.prompt) || "").slice(0, 2000), imageId: (p && p.imageId) || "", sim: (p && p.sim) || "",
          min: Math.max(0.5, Math.min(Number(p && p.min) || 3, 60)) })),
      }));
      return { ...pg, questions: qs };
    });
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
      from: this.live.from || 0,
      total: this.pages().length,
      pages,
      myVotes,
      closed,
      goto: this.live.goto || null,
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

  // Signed-in students for the live list: code, page, connected or not, and time away this class.
  // Codes only; the teacher's computer swaps in names from its own file.
  studentList() {
    const now = Date.now();
    const on = new Map(); // code -> page
    for (const ws of this.ctx.getWebSockets("student")) {
      if (ws.readyState !== 1) continue;
      const a = ws.deserializeAttachment() || {};
      const stu = this.studentFrom(a.stoken);
      if (stu) on.set(stu.name, a.page || 0);
    }
    for (const info of this.pollers.values()) {
      if (info.code && now - info.t <= POLL_PRESENT_MS && !on.has(info.code)) on.set(info.code, info.page || 0);
    }
    // everyone on the class list, signed in or not
    const cls = new Map();
    for (const pd of this.roster.periods) for (const st of pd.students) cls.set(st.code, pd.name);
    const codes = new Set([...cls.keys(), ...on.keys(), ...Object.keys(this.watch)]);
    return [...codes].map((code) => {
      const w = this.watch[code] || { away: false, count: 0, ms: 0, since: 0 };
      return { code, cls: cls.get(code) || "", connected: on.has(code), page: on.has(code) ? on.get(code) : null,
        away: w.away, count: w.count, ms: w.ms + (w.away ? now - w.since : 0), awaySince: w.away ? w.since : 0 };
    });
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
      students: this.studentList(),
      now: Date.now(),
      askAnswers: this.live && this.live.ask ? this.qa[this.live.ask.id] || {} : {},
      qs: this.qs,
      spCounts: this.spCounts(),
      sq: this.live ? this.sq : [],
      act: this.live ? this.act || {} : {},
      sev: this.live ? this.sev || {} : {},
      sky: await this.skyTeacherState(),
    };
  }

  notePoller(sid, page, stu) {
    const prev = this.pollers.get(sid);
    const pg = Number(page) || 0;
    this.pollers.set(sid, { page: pg, t: Date.now(), stuId: stu ? stu.id : null, code: stu ? stu.name : null });
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
    } else if (role === "screen") {
      this.ctx.acceptWebSocket(server, ["screen"]);
      server.serializeAttachment({ role: "screen" });
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
          else if (role === "screen") server.send(JSON.stringify({ t: "state", state: this.screenState() }));
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
        const sc = JSON.stringify({ t: "state", state: this.screenState() });
        for (const ws of this.ctx.getWebSockets("screen")) {
          try { ws.send(sc); } catch {}
        }
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
