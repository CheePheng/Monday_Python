import { describe, it, expect, vi } from "vitest";
import type { RunOpts } from "../../src/types";

/**
 * ADVERSARY LENS -- ONE seeded, deterministic simulation that tries to make the 02.2 follow-up reminder send a SECOND
 * EMAIL for one (contact, assignment, checkpoint), or LOSE a due one.
 *
 * REAL CODE: follow-up-reminder.ts and owner-notice.ts; monday.ts's gql / setColumns / findItemByColumn /
 * getUsersByEmail over a stubbed global fetch; activity-registry.ts's getWatermark / setWatermark / acquireLock /
 * renewLock / releaseLock over the REAL CreateIdempotency class (its claimLock / renewLock / releaseLock / getCard /
 * rememberPermanent), one instance per Durable Object name, serialised like blockConcurrencyWhile.
 * STUBBED: hubspot.ts hs (search / contact GET / owner GET) and card-registry.ts lookupCard (vi.mock, the rest of each
 * module real).
 *
 * THE WORLD: a virtual clock (its own event queue: every setTimeout in the code -- gql's rate-limit waits and
 * back-offs included -- and every simulated latency is an event on it; Date.now reads it); HubSpot contacts with a
 * property history (assignment, activity, reassignment), a search index that lags by `indexLagMs`; one Contacts card
 * per contact (跟进提醒 with index/changed_at, Contact owner, synced after a reassignment); workflow #07/#07b, which on
 * every CHANGE INTO 30分钟未跟进 / 60分钟未跟进 emails the card's Contact owner after `wf.delayMs` and sets 已提醒 (or
 * nothing at all when off); crons firing every 5 minutes from T0+30 to T0+95 (with jitter), overlapping freely, each
 * killed at Cloudflare's 15-minute wall limit.
 *
 * FAULTS, at any external call of any run (DO, HubSpot, registry, monday): A fails without applying; B applies, then
 * its reply is lost (a throw, or a 504); C the invocation is abandoned before the call (its promise never continues);
 * D abandoned after the call applied; E monday rate-limited (never applied; elsewhere like A); F slow (20-60 s);
 * G monday gives no reply for 60-100 s (a 524) and commits the write 0-60 s after that; H monday answers after 60-100 s
 * (Cloudflare's 524 edge). Plus optional monday "incidents" (every call 15-60 s, or 30-100 s when severe, many
 * rate-limited).
 *
 * Every email is attributed to the key whose "pending" note its writer saved last for that contact -- the label write
 * always follows its own note -- so "emails per key" is exact even across overlapping runs.
 *
 * Knobs (env): ADV_SCALE multiplies every sweep's seed count; ADV_DEBUG="<class>|<seed>|<faults json>" prints one trace;
 * ADV_IMPL=patched runs everything against test/_verify/adversary-patched-follow-up-reminder.ts (the proposed minimal
 * fixes; ADV_LABEL_WAITS=loop|0|1 and ADV_SETTLE_MIN pick its label variant) instead of src/follow-up-reminder.ts.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
vi.mock("../../src/sync", () => ({}));
const hooks = vi.hoisted(() => ({
  hs: (..._a: any[]): Promise<any> => Promise.reject(new Error("no simulated world")),
  lookupCard: (..._a: any[]): Promise<string | null> => Promise.reject(new Error("no simulated world")),
}));
vi.mock("../../src/hubspot", async (orig) => ({ ...(await orig<any>()), hs: (...a: any[]) => hooks.hs(...a) }));
vi.mock("../../src/card-registry", async (orig) => ({
  ...(await orig<any>()), lookupCard: (...a: any[]) => hooks.lookupCard(...a),
}));

const { CreateIdempotency } = await import("../../src/create-idempotency-do");
/** The code under test: the real rewrite, or (ADV_IMPL=patched) its copy with the proposed minimal fixes applied. */
const FUR: { runFollowUpReminders: (env: any, opts: RunOpts) => Promise<any> } = process.env.ADV_IMPL === "patched"
  ? await import("./adversary-patched-follow-up-reminder")
  : await import("../../src/follow-up-reminder");

// ------------------------------------------------------------------------------------------------ constants
const SEC = 1_000, MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const L30 = "30分钟未跟进", L60 = "60分钟未跟进", DONE = "已提醒";
const INDEX: Record<string, number> = { [L30]: 0, [DONE]: 1, [L60]: 2 };
const TRIGGERS = new Set([L30, L60]);
const OWNERS: Record<string, { email: string; user: string | null }> = {
  "77": { email: "o77@example.test", user: "501" },
  "78": { email: "o78@example.test", user: "502" },
  "79": { email: "o79@example.test", user: null },          // no monday seat: the card shows nobody
};
const LIVE: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const RUNS = 14;                                              // T0+30 .. T0+95, every 5 minutes

// ------------------------------------------------------------------------------------------------ rng
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(...xs: (number | string)[]): number {
  let h = 2166136261;
  for (const x of xs) for (const ch of String(x) + "|") { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const U = (r: () => number, a: number, b: number) => a + (b - a) * r();
const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];

function fmt(t: number): string {
  const d = t - T0, a = Math.abs(d);
  return `T0${d < 0 ? "-" : "+"}${String(Math.floor(a / MIN)).padStart(2, "0")}:${((a % MIN) / 1000).toFixed(3).padStart(6, "0")}`;
}

// ------------------------------------------------------------------------------------------------ the clock
type Ev = { t: number; s: number; fn: () => void; off?: boolean };
const realSetImmediate = globalThis.setImmediate;
const drain = () => new Promise<void>(r => realSetImmediate(() => r()));

class Sched {
  now = 0;
  private n = 0;
  private h: Ev[] = [];
  private less(a: Ev, b: Ev) { return a.t < b.t || (a.t === b.t && a.s < b.s); }
  at(t: number, fn: () => void): Ev {
    const e: Ev = { t: Math.max(t, this.now), s: this.n++, fn };
    const h = this.h; h.push(e);
    let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(h[i], h[p])) break; [h[i], h[p]] = [h[p], h[i]]; i = p; }
    return e;
  }
  after(ms: number, fn: () => void): Ev { return this.at(this.now + Math.max(0, Math.round(Number(ms) || 0)), fn); }
  private pop(): Ev {
    const h = this.h, top = h[0], last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]]; i = m;
      }
    }
    return top;
  }
  async run(until: number, onError: (e: unknown) => void) {
    while (this.h.length && this.h[0].t <= until) {
      const e = this.pop();
      if (e.off) continue;
      this.now = e.t;
      try { e.fn(); } catch (err) { onError(err); }
      await drain();
    }
  }
}

// ------------------------------------------------------------------------------------------------ configuration
type Kind = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
const KINDS: Kind[] = ["A", "B", "C", "D", "E", "F", "G", "H"];
const KIND_TEXT: Record<Kind, string> = {
  A: "fails, not applied", B: "applies, then its reply is lost", C: "invocation abandoned before the call",
  D: "invocation abandoned after the call applied", E: "rate-limited, not applied (non-monday: fails)",
  F: "slow (monday 20-60 s)",
  G: "monday: no reply for 60-100 s (a 524), and the write COMMITS 0-60 s AFTER that reply (elsewhere: like B)",
  H: "monday: very slow, 60-100 s -- Cloudflare's 524 limit -- then succeeds (elsewhere: slow)",
};
/** A fault: by call index in its run (`call`), or by the nth call whose description contains `match`. `ms`: monday's
 *  time to apply / answer (overrides the drawn latency); `retryIn`: retry_in_seconds of an E refusal. */
interface Fault { run: number; kind: Kind; call?: number; match?: string; nth?: number; ms?: number; retryIn?: number;
  /** G only: the commit comes this long after the timed-out reply (else drawn, 0-60 s). */
  late?: number }

interface ContactCfg {
  id: string; item: string; owner: string; assigned: number; created: number; term: string;
  registryHit: boolean; cardBornAt: number;
  cell: { label: string | null; changedAt: number | null; phantom: string };
  activityAt?: number;
  reassign?: { at: number; owner: string; syncMs: number };
}
interface Cfg {
  seed: number; klass: string;
  contacts: ContactCfg[];
  wf: { on: boolean; delayMs: number };
  jitter: number[]; indexLagMs: number; skewMs: number; hsFormat: "iso" | "epoch" | "mixed";
  /** monday degraded: every call 15-60 s (severe: 30-100 s), and rate-limited with probability rateP. */
  incident?: { from: number; to: number; rateP: number; severe?: boolean };
  faults: Fault[];
  trace?: boolean;
}
interface Email { key: string; t: number; sentAt: number; to: string; cid: string; label: string; run: number }
interface Run {
  idx: number; token: string; env: any; calls: number; dead: boolean; startAt: number; endAt?: number; stats?: any;
  pending: Map<string, string>; matchCount: Map<Fault, number>;
}
interface HsProps { owner: string; assigned: number; created: number; term: string; lifecycle: string; lastActivity: number | null }

const seatOf = (owner: string) => (OWNERS[owner]?.user ? [`person:${OWNERS[owner].user}`] : []);
const resp = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

// ------------------------------------------------------------------------------------------------ the world
class World {
  runs: Run[] = [];
  emails: Email[] = [];
  lines: string[] = [];
  anomalies: string[] = [];
  /** Emails #07 sent for an assignment HubSpot had already replaced when the label landed (informational). */
  superseded: string[] = [];
  /** Path coverage: how often each dangerous path was actually taken. */
  m: Record<string, number> = {};
  bump(k: string, n = 1) { this.m[k] = (this.m[k] ?? 0) + n; }
  private byToken = new Map<string, Run>();
  private byEnv = new Map<any, Run>();
  private dos = new Map<string, any>();
  private cells = new Map<string, { label: string | null; changedAt: number | null; phantom: string; owner: string[] }>();

  constructor(readonly cfg: Cfg, readonly S: Sched) {
    for (const c of cfg.contacts) {
      this.cells.set(c.item, { ...c.cell, owner: seatOf(c.owner) });
      if (c.reassign) {
        const ra = c.reassign;
        S.at(ra.at, () => this.t(null, `HubSpot: contact ${c.id} REASSIGNED to owner ${ra.owner} (new stamp ${ra.at})`));
        S.at(ra.at + ra.syncMs, () => {
          this.cells.get(c.item)!.owner = seatOf(ra.owner);
          this.t(null, `sync: card ${c.item} Contact owner -> ${seatOf(ra.owner).join(",") || "nobody"}`);
        });
      }
      if (c.activityAt !== undefined) S.at(c.activityAt, () => this.t(null, `HubSpot: activity logged on ${c.id}`));
    }
  }

  t(run: Run | null, msg: string) {
    if (this.cfg.trace) this.lines.push(`${fmt(this.S.now)} ${run ? `R${String(run.idx).padStart(2)}` : "   "} ${msg}`);
  }
  log(line: string) {
    const a = /action=([\w-]+)/.exec(line)?.[1];
    if (a && a !== "run") this.bump(`log:${a}${/rate-limited/.test(line) ? "(rate-limit release)" : ""}`);
    if (this.cfg.trace) this.lines.push(`${fmt(this.S.now)}     | ${line}`);
  }

  private rng(run: Run, idx: number, salt: string) { return mulberry32(hash(this.cfg.seed, run.idx, idx, salt)); }
  private die(run: Run, why: string) {
    if (!run.dead) { run.dead = true; this.bump("runs abandoned"); this.t(run, `!! invocation ABANDONED: ${why}`); }
  }
  private alive(except: Run) { return this.runs.filter(x => x !== except && !x.dead && x.endAt === undefined); }
  private deliver(run: Run, ms: number, fn: () => void) { this.S.after(ms, () => { if (!run.dead) fn(); }); }

  private take(run: Run, what: string): { idx: number; f?: Kind; fx?: Fault } {
    const idx = run.calls++;
    let fx: Fault | undefined;
    for (const x of this.cfg.faults) {
      if (x.run !== run.idx) continue;
      if (x.call !== undefined && x.call === idx) fx = x;
      if (x.match !== undefined && what.includes(x.match)) {
        const n = run.matchCount.get(x) ?? 0;
        run.matchCount.set(x, n + 1);
        if (n === (x.nth ?? 0)) fx = x;
      }
    }
    const f = fx?.kind;
    if (f) this.bump(`fault ${f} on ${what.replace(/\(.*$/, "")}`);
    this.t(run, `#${idx} ${what}${f ? `   <<FAULT ${f}: ${KIND_TEXT[f]}${fx?.ms !== undefined ? `, ${fx.ms / SEC} s` : ""}>>` : ""}`);
    return { idx, f, fx };
  }

  startRun(k: number) {
    const run: Run = { idx: k, token: `token-run-${k}`, env: null, calls: 0, dead: false, startAt: this.S.now,
      pending: new Map(), matchCount: new Map() };
    run.env = {
      ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: run.token, HUBSPOT_ACCESS_TOKEN: "hs",
      CREATE_IDEMPOTENCY: { idFromName: (n: string) => n, get: (id: string) => this.stub(run, id) },
    };
    this.runs.push(run); this.byToken.set(run.token, run); this.byEnv.set(run.env, run);
    this.t(run, `== cron fires: run ${k} starts`);
    FUR.runFollowUpReminders(run.env, LIVE).then(
      s => { run.endAt = this.S.now; run.stats = s; this.t(run, `== run ${k} ends ${JSON.stringify(s)}`); },
      e => { run.endAt = this.S.now; this.anomalies.push(`run ${k} threw: ${String(e)}`); });
    this.S.after(15 * MIN, () => { if (run.endAt === undefined) this.die(run, "Cloudflare's 15-minute wall limit"); });
  }

  // ---------------------------------------------------------------- Durable Objects (the real class)
  private doInst(name: string): any {
    let d = this.dos.get(name);
    if (!d) {
      const map = new Map<string, any>();
      let chain: Promise<unknown> = Promise.resolve();
      const ctx = {
        storage: {
          get: async (k: string) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
          put: async (k: string, v: any) => { map.set(k, structuredClone(v)); },
          delete: async (k: string) => map.delete(k),
          deleteAll: async () => { map.clear(); },
          setAlarm: async () => {}, deleteAlarm: async () => {},
        },
        blockConcurrencyWhile: (fn: () => Promise<any>) => { const p = chain.then(() => fn()); chain = p.catch(() => undefined); return p; },
      };
      d = new (CreateIdempotency as any)(ctx, {});
      this.dos.set(name, d);
    }
    return d;
  }
  private stub(run: Run, name: string) {
    return new Proxy({}, { get: (_t, m) => (m === "then" ? undefined : (...args: any[]) => this.doCall(run, name, String(m), args)) });
  }
  private doCall(run: Run, name: string, method: string, args: any[]): Promise<any> {
    const short = name.startsWith("wm:fur:") ? `note ${name.slice(7)}` : name;
    const shown = method === "rememberPermanent" ? `, "${args[0]}"` : method === "claimLock" ? `, hold ${args[1] / 1000}s` : "";
    const { idx, f: f0 } = this.take(run, `DO.${method}(${short}${shown})`);
    const f: Kind | undefined = f0 === "G" ? "B" : f0 === "H" ? "F" : f0;
    if (method === "rememberPermanent" && name.startsWith("wm:fur:") && String(args[0]).startsWith("pending:"))
      run.pending.set(name.slice(7).split(":")[0], name.slice(7));
    return new Promise((res, rej) => {
      if (run.dead) return;
      if (f === "C") return this.die(run, `before DO.${method}`);
      const r = this.rng(run, idx, "do");
      const apply = f === "F" ? U(r, 5 * SEC, 30 * SEC) : U(r, 2, 40);
      const reply = U(r, 1, 20);
      this.S.after(apply, async () => {
        if (f === "A" || f === "E") {
          this.t(run, `   DO.${method}(${short}) FAILED, not applied`);
          this.deliver(run, reply, () => rej(new Error(`${method}: Network connection lost`)));
          return;
        }
        let out: any, err: any;
        try { out = await this.doInst(name)[method](...args); } catch (e) { err = e; }
        this.t(run, `   DO.${method}(${short}) applied -> ${err ? `throws ${err}` : JSON.stringify(out)}`);
        if (method === "claimLock" && out === true && this.alive(run).length) this.bump("lock taken while an earlier run is still alive");
        if (method === "renewLock" && out === false) this.bump("renewal refused");
        if (method === "rememberPermanent" && String(args[0]) === "" && name.startsWith("wm:fur:")) this.bump("note released");
        if (f === "D") return this.die(run, `after DO.${method} applied`);
        if (f === "B") {
          this.deliver(run, reply, () => rej(new Error(`${method}: Durable Object reset after the write`)));
          return;
        }
        this.deliver(run, reply, () => (err ? rej(err) : res(out)));
      });
    });
  }

  // ---------------------------------------------------------------- the card registry (lookupCard is soft)
  lookupCard(env: any, _board: string, id: string): Promise<string | null> {
    const run = this.byEnv.get(env)!;
    const { idx, f: f0 } = this.take(run, `registry.lookupCard(${id})`);
    const f: Kind | undefined = f0 === "G" ? "B" : f0 === "H" ? "F" : f0;
    const r = this.rng(run, idx, "reg");
    const lat = f === "F" ? U(r, 1 * SEC, 5 * SEC) : U(r, 2, 30);
    return new Promise(res => {
      if (run.dead) return;
      if (f === "C") return this.die(run, "before registry.lookupCard");
      this.S.after(lat, () => {
        if (f === "D") return this.die(run, "after registry.lookupCard");
        const c = this.cfg.contacts.find(x => x.id === id);
        const soft = f === "A" || f === "B" || f === "E";
        const hit = !!c && c.registryHit && c.cardBornAt <= this.S.now && !soft;
        this.deliver(run, 1, () => res(hit ? c!.item : null));
      });
    });
  }

  // ---------------------------------------------------------------- HubSpot
  private stateAt(c: ContactCfg, t: number): HsProps {
    const p: HsProps = { owner: c.owner, assigned: c.assigned, created: c.created, term: c.term, lifecycle: "lead",
      lastActivity: null };
    if (c.activityAt !== undefined && c.activityAt <= t) p.lastActivity = c.activityAt;
    if (c.reassign && c.reassign.at <= t) { p.owner = c.reassign.owner; p.assigned = c.reassign.at; }
    return p;
  }
  private fmtTime(t: number | null, r: () => number): string | null {
    if (t === null) return null;
    const f = this.cfg.hsFormat === "mixed" ? (r() < 0.5 ? "iso" : "epoch") : this.cfg.hsFormat;
    return f === "iso" ? new Date(t).toISOString() : String(t);
  }
  private props(p: HsProps, r: () => number) {
    return { hubspot_owner_id: p.owner, hubspot_owner_assigneddate: this.fmtTime(p.assigned, r),
      createdate: this.fmtTime(p.created, r), utm_term: p.term, lifecyclestage: p.lifecycle,
      notes_last_updated: this.fmtTime(p.lastActivity, r) };
  }
  private match(p: HsProps, f: any): boolean {
    const v = f.propertyName === "hubspot_owner_assigneddate" ? p.assigned : f.propertyName === "createdate" ? p.created
      : f.propertyName === "lifecyclestage" ? p.lifecycle : f.propertyName === "utm_term" ? p.term : undefined;
    if (v === undefined) throw new Error(`unknown search property ${f.propertyName}`);
    switch (f.operator) {
      case "GTE": return Number(v) >= Number(f.value);
      case "LTE": return Number(v) <= Number(f.value);
      case "EQ": return String(v) === String(f.value);
      case "HAS_PROPERTY": return v !== null && v !== "";
    }
    throw new Error(`unknown operator ${f.operator}`);
  }
  private hubspot(method: string, path: string, body: any, r: () => number): any {
    if (method === "POST" && path === "/crm/v3/objects/contacts/search") {
      const filters = body?.filterGroups?.[0]?.filters ?? [];
      const view = this.cfg.contacts.map(c => ({ c, p: this.stateAt(c, this.S.now - this.cfg.indexLagMs) }));
      const ok = view.filter(({ p }) => filters.every((f: any) => this.match(p, f)));
      ok.sort((a, b) => a.p.assigned - b.p.assigned || Number(a.c.id) - Number(b.c.id));
      const from = Number(body.after ?? 0), lim = Number(body.limit ?? 100);
      const page = ok.slice(from, from + lim);
      return { total: ok.length, results: page.map(({ c, p }) => ({ id: c.id, properties: this.props(p, r) })),
        ...(from + lim < ok.length ? { paging: { next: { after: String(from + lim) } } } : {}) };
    }
    const contact = /^\/crm\/v3\/objects\/contacts\/(\w+)\?/.exec(path);
    if (method === "GET" && contact) {
      const c = this.cfg.contacts.find(x => x.id === contact[1]);
      if (!c) throw new Error(`hubspot GET ${path}: 404 Not Found`);
      return { id: c.id, properties: this.props(this.stateAt(c, this.S.now), r) };
    }
    const owner = /^\/crm\/v3\/owners\/(\w+)/.exec(path);
    if (method === "GET" && owner) {
      const o = OWNERS[owner[1]];
      if (!o) throw new Error(`hubspot GET ${path}: 404 Not Found`);
      return { id: owner[1], email: o.email };
    }
    throw new Error(`unexpected HubSpot call ${method} ${path}`);
  }
  hs(env: any, method: string, path: string, body?: any): Promise<any> {
    const run = this.byEnv.get(env)!;
    const what = method === "POST" ? "search" : path.startsWith("/crm/v3/owners/") ? `GET owner ${path.split("/")[4]}`
      : `GET contact ${/contacts\/(\w+)/.exec(path)?.[1]}`;
    const { idx, f: f0 } = this.take(run, `hubspot.${what}`);
    const f: Kind | undefined = f0 === "G" ? "B" : f0 === "H" ? "F" : f0;
    const r = this.rng(run, idx, "hs");
    const lat = f === "F" ? U(r, 5 * SEC, 20 * SEC) : U(r, 80, 600);
    return new Promise((res, rej) => {
      if (run.dead) return;
      if (f === "C") return this.die(run, `before hubspot.${what}`);
      this.S.after(lat, () => {
        if (f === "D") return this.die(run, `after hubspot.${what}`);
        if (f === "A" || f === "B" || f === "E") {
          this.deliver(run, 1, () => rej(new Error(`hubspot ${method} ${path}: 503 Service Unavailable`)));
          return;
        }
        let out: any;
        try { out = this.hubspot(method, path, body, r); }
        catch (e) { this.deliver(run, 1, () => rej(e)); return; }
        this.deliver(run, 1, () => res(out));
      });
    });
  }

  // ---------------------------------------------------------------- monday (behind the real gql)
  private contactOfItem(item: string) { return this.cfg.contacts.find(c => c.item === String(item)); }
  private write(item: string, label: string | null, run: Run, what: string) {
    const c = this.contactOfItem(item);
    const cell = this.cells.get(String(item));
    if (!c || !cell) throw new Error(`no such item ${item}`);
    const before = cell.label;
    if (label === before) {
      if (label) this.bump("label write that changed nothing");
      this.t(run, `   board ${c.id}: ${what} is NO CHANGE (cell already ${before ?? "empty"})`);
      return;
    }
    if (label !== null && this.alive(run).length) this.bump("label applied while another run is alive");
    cell.label = label;
    cell.changedAt = label === null ? null : this.S.now + this.cfg.skewMs;
    if (label === null || !TRIGGERS.has(label)) { this.t(run, `   board ${c.id}: ${before ?? "empty"} -> ${label ?? "empty"}`); return; }
    const key = run.pending.get(c.id) ?? `unattributed:${c.id}:${label}`;
    const cp = label === L30 ? "30" : "60";
    if (key.split(":")[2] !== cp) this.anomalies.push(`label ${label} written under key ${key}`);
    const current = this.stateAt(c, this.S.now).assigned;
    if (String(current) !== key.split(":")[1]) this.superseded.push(`${key} landed at ${fmt(this.S.now)} (current stamp ${current})`);
    this.t(run, `   board ${c.id}: ${before ?? "empty"} -> ${label}  ** CHANGE INTO a trigger label: #07 fires (key ${key}) **`);
    if (!this.cfg.wf.on) return;
    const firedAt = this.S.now;
    this.S.after(this.cfg.wf.delayMs, () => {
      this.emails.push({ key, t: firedAt, sentAt: this.S.now, to: cell.owner.join(",") || "nobody(cc only)", cid: c.id,
        label, run: run.idx });
      this.t(null, `#07 EMAILS ${cell.owner.join(",") || "nobody (CC only)"} for key ${key}; sets ${DONE}`);
      if (cell.label !== DONE) { cell.label = DONE; cell.changedAt = this.S.now + this.cfg.skewMs; }
    });
  }
  private board(query: string, vars: any, run: Run, what: string): any {
    if (/change_multiple_column_values/.test(query)) {
      const cv = JSON.parse(vars.c);
      if (!(STATUS in cv) || Object.keys(cv).length !== 1) this.anomalies.push(`a write to columns ${Object.keys(cv)}`);
      const v = cv[STATUS];
      this.write(String(vars.i), v === null ? null : String(v.label), run, what);
      return { change_multiple_column_values: { id: String(vars.i) } };
    }
    if (/items_page_by_column_values/.test(query)) {
      const c = this.cfg.contacts.find(x => x.id === String(vars.v?.[0]));
      const items = c && c.cardBornAt <= this.S.now
        ? [{ id: c.item, name: "card", created_at: "", updated_at: "", group: { id: "g" }, column_values: [] }] : [];
      return { items_page_by_column_values: { items } };
    }
    if (/users\s*\(/.test(query)) {
      return { users: Object.values(OWNERS).filter(o => o.user).map(o => ({ id: o.user, email: o.email })) };
    }
    if (/items\s*\(\s*ids/.test(query)) {
      const c = this.contactOfItem(String(vars.i?.[0]));
      if (!c || c.cardBornAt > this.S.now) return { items: [] };
      const cell = this.cells.get(c.item)!;
      const status = cell.label
        ? { id: STATUS, text: cell.label, index: INDEX[cell.label],
            value: JSON.stringify({ index: INDEX[cell.label], post_id: null,
              ...(cell.changedAt !== null ? { changed_at: new Date(cell.changedAt).toISOString() } : {}) }) }
        : { id: STATUS, text: cell.phantom, index: null, value: null };
      const owner = { id: OWNER_COL, text: "", value: null,
        persons_and_teams: cell.owner.map(p => ({ id: p.split(":")[1], kind: p.split(":")[0] })) };
      return { items: [{ column_values: [status, owner] }] };
    }
    throw new Error(`unexpected monday query ${query.slice(0, 80)}`);
  }
  mondayFetch(_url: unknown, init: any): Promise<any> {
    const run = this.byToken.get(init?.headers?.Authorization);
    if (!run) return Promise.reject(new Error("a monday call from no known run"));
    const { query, variables } = JSON.parse(init.body);
    const what = /change_multiple_column_values/.test(query)
      ? (JSON.parse(variables.c)[STATUS] === null ? "clear" : `label(${JSON.parse(variables.c)[STATUS]?.label})`)
      : /items_page_by_column_values/.test(query) ? "findItemByColumn" : /users\s*\(/.test(query) ? "users"
      : /items\s*\(\s*ids/.test(query) ? "readCells" : "other";
    const { idx, f: f0, fx } = this.take(run, `monday.${what}`);
    const r = this.rng(run, idx, "monday");
    let f = f0;
    let apply = U(r, 150, 1_200);
    const reply = U(r, 20, 250);
    const inc = this.cfg.incident;
    if (!f && inc && this.S.now >= inc.from && this.S.now <= inc.to) {
      apply = inc.severe ? U(r, 30 * SEC, 100 * SEC) : U(r, 15 * SEC, 60 * SEC);
      if (r() < inc.rateP) f = "E";
      this.t(run, `   (monday incident: ${(apply / SEC).toFixed(0)} s${f === "E" ? ", rate-limited" : ""})`);
    }
    if (f === "F") apply = U(r, 20 * SEC, 60 * SEC);
    if (f === "H") apply = U(r, 60 * SEC, 100 * SEC);
    if (fx?.ms !== undefined) apply = fx.ms;
    if (what.startsWith("label")) this.bump("label writes sent");
    if (what === "clear") this.bump("clears sent");
    return new Promise((res, rej) => {
      if (run.dead) return;
      if (f === "C") return this.die(run, `before monday.${what}`);
      if (f === "G") {
        // The reply never comes back in time (a 524 after 60-100 s), and monday commits the write LATER still.
        const timeout = fx?.ms ?? U(r, 60 * SEC, 100 * SEC), late = fx?.late ?? U(r, 0, 60 * SEC);
        this.deliver(run, timeout, () => res(resp(524, { error_message: "A timeout occurred" })));
        this.S.after(timeout + late, () => {
          this.t(run, `   monday.${what} COMMITS LATE (${((timeout + late) / SEC).toFixed(0)} s after it was sent)`);
          try { this.board(query, variables, run, what); } catch (e) { this.anomalies.push(String(e)); }
        });
        return;
      }
      this.S.after(apply, () => {
        if (f === "E") {
          const n = fx?.retryIn ?? Math.floor(U(r, 5, 64));
          this.t(run, `   monday.${what} REFUSED: rate-limited, retry_in_seconds ${n} (not applied)`);
          this.deliver(run, reply, () => res(resp(429, { errors: [{ message: "Complexity budget exhausted",
            extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED", retry_in_seconds: n } }] })));
          return;
        }
        if (f === "A") {
          this.t(run, `   monday.${what} FAILED (not applied)`);
          const thrown = r() < 0.5;
          this.deliver(run, reply, () => (thrown ? rej(new TypeError("fetch failed"))
            : res(resp(500, { error_message: "Internal Server Error" }))));
          return;
        }
        let data: any;
        try { data = this.board(query, variables, run, what); }
        catch (e) { this.anomalies.push(String(e)); this.deliver(run, reply, () => res(resp(200, { errors: [{ message: String(e) }] }))); return; }
        if (f === "D") return this.die(run, `after monday.${what} applied`);
        if (f === "B") {
          this.t(run, `   monday.${what} applied, its REPLY IS LOST`);
          const thrown = r() < 0.5;
          this.deliver(run, reply, () => (thrown ? rej(new Error("Network connection lost"))
            : res(resp(504, { error_message: "Gateway Timeout" }))));
          return;
        }
        this.deliver(run, reply, () => res(resp(200, { data })));
      });
    });
  }
}

// ------------------------------------------------------------------------------------------------ one simulation
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, fetch: globalThis.fetch,
  now: Date.now, log: console.log };

async function simulate(cfg: Cfg): Promise<World> {
  const S = new Sched();
  S.now = T0 + 29 * MIN;
  const W = new World(cfg, S);
  for (let k = 0; k < RUNS; k++) S.at(T0 + (30 + 5 * k) * MIN + (cfg.jitter[k] ?? 0), () => W.startRun(k));
  (globalThis as any).setTimeout = (fn: any, ms?: number, ...args: any[]) => S.after(ms ?? 0, () => fn(...args));
  (globalThis as any).clearTimeout = (e: any) => { if (e && typeof e === "object") e.off = true; };
  (globalThis as any).fetch = (u: unknown, i: any) => W.mondayFetch(u, i);
  Date.now = () => S.now;
  console.log = (...a: unknown[]) => W.log(a.map(String).join(" "));
  hooks.hs = (...a: any[]) => W.hs(a[0], a[1], a[2], a[3]);
  hooks.lookupCard = (...a: any[]) => W.lookupCard(a[0], a[1], a[2]);
  try {
    await S.run(T0 + 200 * MIN, e => W.anomalies.push(`event threw: ${String(e)}`));
  } finally {
    (globalThis as any).setTimeout = real.setTimeout;
    (globalThis as any).clearTimeout = real.clearTimeout;
    (globalThis as any).fetch = real.fetch;
    Date.now = real.now;
    console.log = real.log;
  }
  return W;
}

const byKey = (W: World) => {
  const m = new Map<string, Email[]>();
  for (const e of W.emails) m.set(e.key, [...(m.get(e.key) ?? []), e]);
  return m;
};

/** AT MOST ONE EMAIL per (contact, assignment, checkpoint) -- and every email belongs to a key. */
function doubles(W: World): string[] {
  const out: string[] = [];
  for (const [key, es] of byKey(W)) {
    if (key.startsWith("unattributed")) out.push(`${key}: ${es.length} email(s) with no pending note behind them`);
    else if (es.length > 1) out.push(`${key}: ${es.length} emails, label changes at ${es.map(e => `${fmt(e.t)} by run ${e.run}`).join(" and ")}`);
  }
  return out;
}
/** EXACTLY ONE EMAIL for each due checkpoint, inside its window (liveness configurations only). */
function losses(cfg: Cfg, W: World): string[] {
  const m = byKey(W), out: string[] = [];
  for (const c of cfg.contacts) for (const cp of [30, 60]) {
    const key = `${c.id}:${c.assigned}:${cp}`;
    const es = m.get(key) ?? [];
    const lo = c.assigned + cp * MIN, hi = c.assigned + (cp + 30) * MIN + 5 * MIN;
    const inWindow = es.filter(e => e.t >= lo && e.t <= hi).length;
    if (es.length !== 1 || inWindow !== 1) out.push(`${key}: ${es.length} email(s), ${inWindow} inside its window`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ seeds
function contactBase(r: () => number, i: number, assigned: number): ContactCfg {
  const owner = pick(r, ["77", "77", "78", "79"]);
  const cellKind = pick(r, ["empty", "phantom", "done", "l30", "l60"]);
  const old = assigned - Math.round(U(r, 1, 48) * 60 * MIN);
  const cell = cellKind === "empty" ? { label: null, changedAt: null, phantom: "" }
    : cellKind === "phantom" ? { label: null, changedAt: null, phantom: pick(r, [DONE, L30, "5无意向"]) }
    : { label: cellKind === "done" ? DONE : cellKind === "l30" ? L30 : L60, changedAt: old, phantom: "" };
  return {
    id: String(9001 + i), item: String(5551 + i), owner, assigned,
    created: assigned - Math.round(U(r, 1 * MIN, 23 * 60 * MIN)),
    term: pick(r, ["docusign", "DocuSign下载", "hubspot", "HubSpot CRM", "sumsub+hubspot"]),
    registryHit: r() < 0.8, cardBornAt: T0 - 60 * MIN, cell,
  };
}
function randomFaults(r: () => number, n: number, runs: number[]): Fault[] {
  return Array.from({ length: n }, () => ({ run: pick(r, runs), call: Math.floor(U(r, 0, 45)), kind: pick(r, KINDS) }));
}
const ALL_RUNS = Array.from({ length: RUNS }, (_, k) => k);

/** Anything goes: faults anywhere, incidents, slow or absent #07, reassignments, activity, late cards. */
function safetyCfg(seed: number): Cfg {
  const r = mulberry32(hash("safety", seed));
  const n = r() < 0.55 ? 1 : r() < 0.6 ? 2 : 3;
  const contacts = Array.from({ length: n }, (_, i) => {
    const c = contactBase(r, i, T0 + Math.round(U(r, -4 * MIN, 4 * MIN)));
    if (r() < 0.1) c.cardBornAt = c.assigned + Math.round(U(r, 20 * MIN, 50 * MIN));
    if (r() < 0.2) c.activityAt = c.assigned + Math.round(U(r, 5 * MIN, 85 * MIN));
    if (r() < 0.2) c.reassign = { at: c.assigned + Math.round(U(r, 20 * MIN, 70 * MIN)), owner: pick(r, ["77", "78", "79"]),
      syncMs: Math.round(U(r, 2 * SEC, 120 * SEC)) };
    return c;
  });
  const slow = r();
  const wf = { on: r() < 0.9, delayMs: Math.round(slow < 0.6 ? U(r, 1 * SEC, 15 * SEC) : slow < 0.85 ? U(r, 15 * SEC, 3 * MIN) : U(r, 3 * MIN, 8 * MIN)) };
  const jitter = ALL_RUNS.map(() => Math.round(r() < 0.85 ? U(r, 0, 5 * SEC) : U(r, 5 * SEC, 90 * SEC)));
  const from = T0 + Math.round(U(r, 25 * MIN, 85 * MIN));
  const incident = r() < 0.3 ? { from, to: from + Math.round(U(r, 3 * MIN, 25 * MIN)), rateP: U(r, 0.15, 0.6) } : undefined;
  return { seed, klass: "safety", contacts, wf, jitter, indexLagMs: Math.round(U(r, 0, 4 * MIN)),
    skewMs: Math.round(U(r, -4 * SEC, 4 * SEC)), hsFormat: pick(r, ["iso", "epoch", "mixed"] as const),
    incident, faults: randomFaults(r, Math.floor(U(r, 0, 14)), ALL_RUNS) };
}
/** Biased at the hard part: a card still showing the label (the clear path), monday slow and rate-limiting while
 *  the first runs flag, slow faults, jittered crons. */
function hostileCfg(seed: number): Cfg {
  const r = mulberry32(hash("hostile", seed));
  const n = r() < 0.5 ? 1 : 2;
  const contacts = Array.from({ length: n }, (_, i) => {
    const c = contactBase(r, i, T0 + Math.round(U(r, -4 * MIN, 4 * MIN)));
    c.cell = { label: pick(r, [L30, L30, L60]), changedAt: c.assigned - Math.round(U(r, 1, 30) * 60 * MIN), phantom: "" };
    return c;
  });
  const wf = { on: true, delayMs: Math.round(r() < 0.7 ? U(r, 1 * SEC, 15 * SEC) : U(r, 15 * SEC, 6 * MIN)) };
  const jitter = ALL_RUNS.map(() => Math.round(r() < 0.6 ? U(r, 0, 5 * SEC) : U(r, 5 * SEC, 90 * SEC)));
  const from = T0 + Math.round(U(r, 26 * MIN, 70 * MIN));
  const incident = r() < 0.8 ? { from, to: from + Math.round(U(r, 8 * MIN, 40 * MIN)), rateP: U(r, 0.3, 0.75) } : undefined;
  const faults = randomFaults(r, Math.floor(U(r, 0, 10)), ALL_RUNS);
  for (let i = Math.floor(U(r, 0, 6)); i > 0; i--) faults.push({ run: pick(r, ALL_RUNS), call: Math.floor(U(r, 0, 30)), kind: "F" });
  return { seed, klass: "hostile", contacts, wf, jitter, indexLagMs: Math.round(U(r, 0, 2 * MIN)),
    skewMs: Math.round(U(r, -3 * SEC, 3 * SEC)), hsFormat: pick(r, ["iso", "epoch", "mixed"] as const), incident, faults };
}
/** Severe: monday at Cloudflare's 524 edge (30-100 s a call) and rate-limiting while the first runs flag, late commits
 *  (G) and very slow calls (H), the clear path on every card -- the lock's hold and PENDING_SETTLE_MS under stress. */
function severeCfg(seed: number): Cfg {
  const base = hostileCfg(seed + 1_000_000);
  const r = mulberry32(hash("severe", seed));
  const from = T0 + Math.round(U(r, 26 * MIN, 70 * MIN));
  const faults = base.faults.slice();
  for (let i = Math.floor(U(r, 1, 8)); i > 0; i--)
    faults.push({ run: pick(r, ALL_RUNS), call: Math.floor(U(r, 0, 30)), kind: pick(r, ["G", "H", "H", "E", "B"] as Kind[]) });
  return { ...base, seed, klass: "severe", faults,
    incident: r() < 0.85 ? { from, to: from + Math.round(U(r, 8 * MIN, 40 * MIN)), rateP: U(r, 0.2, 0.7), severe: true } : undefined };
}
/** Liveness with a SLOW #07 (1 s - 8 min before it emails and sets 已提醒): the same few early, transient faults. */
function livenessSlowCfg(seed: number): Cfg {
  const base = livenessCfg(seed + 2_000_000);
  const r = mulberry32(hash("liveness-slow", seed));
  return { ...base, seed, klass: "liveness", wf: { on: true, delayMs: Math.round(r() < 0.5 ? U(r, 1 * SEC, 60 * SEC) : U(r, 1 * MIN, 8 * MIN)) } };
}
/** Liveness with cards created late (T0+30..54, so the 30 still has a run left) and #07 anywhere from 1 s to 8 min. */
function livenessLateCfg(seed: number): Cfg {
  const base = livenessCfg(seed + 3_000_000);
  const r = mulberry32(hash("liveness-late", seed));
  return { ...base, seed, klass: "liveness",
    contacts: base.contacts.map(c => ({ ...c, cardBornAt: T0 + Math.round(U(r, 30 * MIN, 54 * MIN)) })),
    wf: { on: true, delayMs: Math.round(r() < 0.4 ? U(r, 1 * SEC, 60 * SEC) : U(r, 1 * MIN, 8 * MIN)) } };
}
/**
 * Liveness: every fault transient and few (0-3), all in a checkpoint's FIRST four runs (T0+30..45, T0+60..75), #07
 * on and quick, nothing else changing -- so each checkpoint has two clean runs left in its window. Assignments fall
 * 5-55 s before T0, so every run is wholly inside one checkpoint's window.
 */
function livenessCfg(seed: number): Cfg {
  const r = mulberry32(hash("liveness", seed));
  const n = r() < 0.5 ? 1 : r() < 0.6 ? 2 : 3;
  const contacts = Array.from({ length: n }, (_, i) => contactBase(r, i, T0 - Math.round(U(r, 5 * SEC, 55 * SEC))));
  const wf = { on: true, delayMs: Math.round(U(r, 1 * SEC, 15 * SEC)) };
  const jitter = ALL_RUNS.map(() => Math.round(U(r, 0, 5 * SEC)));
  return { seed, klass: "liveness", contacts, wf, jitter, indexLagMs: Math.round(U(r, 0, 60 * SEC)),
    skewMs: Math.round(U(r, -3 * SEC, 3 * SEC)), hsFormat: pick(r, ["iso", "epoch", "mixed"] as const),
    faults: randomFaults(r, Math.floor(U(r, 0, 4)), [0, 1, 2, 3, 6, 7, 8, 9]) };
}

// ------------------------------------------------------------------------------------------------ minimise and report
/** Drop faults (and the incident) one at a time while the property still fails: the shortest schedule found. */
async function minimise(cfg: Cfg, fails: (c: Cfg, W: World) => boolean): Promise<Cfg> {
  let cur = cfg;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < cur.faults.length; i++) {
      const cand = { ...cur, faults: cur.faults.filter((_, j) => j !== i) };
      if (fails(cand, await simulate(cand))) { cur = cand; changed = true; break; }
    }
    if (!changed && cur.incident) {
      const cand = { ...cur, incident: undefined };
      if (fails(cand, await simulate(cand))) { cur = cand; changed = true; }
    }
  }
  return cur;
}
function describeCfg(c: Cfg): string {
  return [
    `seed ${c.seed} (${c.klass})`,
    `contacts: ${c.contacts.map(x => `${x.id} owner ${x.owner} assigned ${fmt(x.assigned)}${x.reassign ? ` reassigned ${fmt(x.reassign.at)}->${x.reassign.owner}` : ""}${x.activityAt ? ` activity ${fmt(x.activityAt)}` : ""} cell ${x.cell.label ?? (x.cell.phantom ? `phantom(${x.cell.phantom})` : "empty")} registry ${x.registryHit ? "hit" : "miss"}`).join("; ")}`,
    `#07 ${c.wf.on ? `on, ${(c.wf.delayMs / SEC).toFixed(1)} s` : "OFF"}; index lag ${(c.indexLagMs / SEC).toFixed(0)} s; monday skew ${c.skewMs} ms; HubSpot dates ${c.hsFormat}`,
    `jitter (s): ${c.jitter.map(j => (j / SEC).toFixed(1)).join(",")}`,
    c.incident ? `monday incident ${fmt(c.incident.from)}..${fmt(c.incident.to)} rate-limit p=${c.incident.rateP.toFixed(2)}` : "no incident",
    `faults: ${c.faults.length ? c.faults.map(f => `run ${f.run} ${f.call !== undefined ? `call #${f.call}` : `"${f.match}"#${f.nth ?? 0}`} ${f.kind}`).join("; ") : "none"}`,
  ].join("\n  ");
}
async function report(title: string, cfg: Cfg, what: (c: Cfg, W: World) => string[]): Promise<string> {
  const W = await simulate({ ...cfg, trace: true });
  const text = [`===== ${title}`, `  ${describeCfg(cfg)}`, `  VIOLATION: ${what(cfg, W).join(" | ")}`,
    ...W.lines.map(l => `    ${l}`)].join("\n");
  real.log(text);
  return text;
}

// ------------------------------------------------------------------------------------------------ the tests
describe("adversary: the follow-up reminder against a simulated world", () => {
  it("CONTROL: no faults -- each checkpoint is emailed exactly once (30 then 60), nothing else written", async () => {
    const cfg: Cfg = { ...livenessCfg(1), faults: [] };
    const W = await simulate(cfg);
    expect(W.anomalies).toEqual([]);
    expect(doubles(W)).toEqual([]);
    expect(losses(cfg, W)).toEqual([]);
    expect(W.emails.length).toBe(cfg.contacts.length * 2);
  });

  it.runIf(!!process.env.ADV_DEBUG)("DEBUG: print one trace (ADV_DEBUG=<class>:<seed>[:faults-json])", async () => {
    const [klass, seed, faults] = String(process.env.ADV_DEBUG).split("|");
    const gen = ({ hostile: hostileCfg, liveness: livenessCfg, severe: severeCfg, "liveness-slow-07": livenessSlowCfg,
      "liveness-late-card": livenessLateCfg } as
      Record<string, (s: number) => Cfg>)[klass] ?? safetyCfg;
    const cfg = { ...gen(Number(seed)), ...(faults ? { faults: JSON.parse(faults) } : {}) };
    await report(`debug ${klass} ${seed}`, cfg, (c, W) => [...doubles(W), ...(c.klass === "liveness" ? losses(c, W) : [])]);
  });

  it("CONTROL: #07 off -- nothing is ever emailed; a slow #07 still one per key", async () => {
    const off: Cfg = { ...livenessCfg(2), wf: { on: false, delayMs: 0 }, faults: [] };
    expect((await simulate(off)).emails).toHaveLength(0);
    const slow: Cfg = { ...livenessCfg(2), wf: { on: true, delayMs: 4 * MIN }, faults: [] };
    const W = await simulate(slow);
    expect(doubles(W)).toEqual([]);
  });
});

// The prior review's duplicate-email findings, each as a fault schedule on one clean contact (no incident, #07 quick).
const one = (faults: Fault[], over: Partial<Cfg> = {}): Cfg => {
  const base = livenessCfg(7);
  return { ...base, contacts: [{ ...base.contacts[0], owner: "77", registryHit: true, cell: { label: null, changedAt: null, phantom: "" } }],
    faults, ...over };
};
const verdict = async (cfg: Cfg) => {
  const W = await simulate(cfg);
  return { doubles: doubles(W), losses: losses(cfg, W), W };
};

describe("adversary: the prior findings as fault schedules", () => {
  it("TWICE-1 / WIRING-3 (a): the label lands but its reply is lost -- never re-sent; the card settles it -- ONE email", async () => {
    const v = await verdict(one([{ run: 0, match: "monday.label", kind: "B" }]));
    expect(v.doubles).toEqual([]);
    expect(v.losses).toEqual([]);
  });
  it("TWICE-1 / WIRING-3 (b): landed, reply lost, and every run after it fails too -- still ONE email", async () => {
    const v = await verdict(one([{ run: 0, match: "monday.label", kind: "B" }, { run: 1, match: "monday.readCells", kind: "A" },
      { run: 2, match: "monday.readCells", kind: "B" }]));
    expect(v.doubles).toEqual([]);
    expect(v.losses).toEqual([]);
  });
  it("TWICE-1: a rate-limited label (refused twice: never ran) is released and sent by the next run -- ONE email", async () => {
    const v = await verdict(one([{ run: 0, match: "monday.label", kind: "E" }, { run: 0, match: "monday.label", nth: 1, kind: "E" }]));
    expect(v.doubles).toEqual([]);
    expect(v.losses).toEqual([]);
  });
  it("TWICE-2 / WIRING-4: the label landed and the 'sent' note failed (both ways) -- resolved from the card, ONE email", async () => {
    for (const kind of ["A", "B", "D"] as Kind[]) {
      const v = await verdict(one([{ run: 0, match: '"sent:', kind }]));
      expect(v.doubles, `sent note fault ${kind}`).toEqual([]);
      expect(v.losses, `sent note fault ${kind}`).toEqual([]);
    }
  });
  it("TWICE-2: the invocation dies right after the label applied -- ONE email", async () => {
    const v = await verdict(one([{ run: 0, match: "monday.label", kind: "D" }]));
    expect(v.doubles).toEqual([]);
    expect(v.losses).toEqual([]);
  });
  it("TWICE-3 / WIRING-1 / WIRING-2: overlapping runs (run 0 slowed past the next ticks) never flag twice", async () => {
    const slow: Fault[] = [0, 1, 2, 3, 4, 5, 6].map(n => ({ run: 0, match: "monday.", nth: n, kind: "F" as Kind }));
    const v = await verdict(one(slow, { contacts: [0, 1, 2].map(i => ({ ...one([]).contacts[0], id: String(9001 + i), item: String(5551 + i), registryHit: i !== 2 })) }));
    expect(v.doubles).toEqual([]);
    expect(v.losses).toEqual([]);
  });
});

/** Name the mechanism behind each violation, from a traced simulation of the minimised schedule. */
function classify(W: World, why: string[]): string[] {
  const out = new Set<string>();
  const L = W.lines;
  const runOf = (l: string) => Number(/^\S+ R\s?(\d+) /.exec(l)?.[1] ?? NaN);
  for (const w of why) {
    const key = w.split(":").slice(0, 3).join(":");
    const n = Number(/: (\d+) email/.exec(w)?.[1] ?? NaN);
    if (key.startsWith("unattributed")) { out.add(`UNATTRIBUTED EMAIL: ${w}`); continue; }
    if (n > 1) {
      const changes = L.filter(l => l.includes(`#07 fires (key ${key})`)).map(runOf);
      const sentBy = new Set<number>();
      let wiped = false;
      for (const l of L) {
        if (l.includes(`rememberPermanent(note ${key}, "sent:`)) sentBy.add(runOf(l));
        if (l.includes(`rememberPermanent(note ${key}, "")`) && [...sentBy].some(r => r !== runOf(l))) wiped = true;
      }
      const late = changes.some((r, i) => i > 0 && r < Math.max(...changes.slice(0, i)));
      const overran = new Set(L.filter(l => l.includes("DO.releaseLock(lock:follow-up) applied -> false")).map(runOf));
      if (wiped) out.add("DOUBLE / LAPSED LOCK: a run whose write outlived its lock released (\"\") a note a newer run had marked sent");
      else if (late) out.add("DOUBLE / LAPSED LOCK: a run whose write outlived its lock landed its label after a newer run had flagged");
      else if (changes.length > 1 && overran.has(changes[0]))
        out.add("DOUBLE / LAPSED LOCK: a newer run read the card while an overrunning run's label was still on its way, and flagged too");
      else if (L.some((l, i) => /monday\.clear COMMITS LATE/.test(l) && /-> empty/.test(L[i + 1] ?? "") && (L[i + 1] ?? "").includes(`board ${key.split(":")[0]}:`)))
        out.add("DOUBLE / LATE CLEAR: a re-sent clear's earlier attempt committed after the label and #07, erasing the proof it landed");
      else if (L.some((l, i) => /monday\.label\(.*COMMITS LATE/.test(l) && (L[i + 1] ?? "").includes(`#07 fires (key ${key})`)))
        out.add("DOUBLE / LATE LABEL COMMIT: the next run judged the note settled before the label (sent minutes after the note) committed");
      else out.add(`DOUBLE / other: ${w}`);
    } else {
      const [id, , cp] = key.split(":");
      const resolved = L.some(l => l.includes(`contact=${id} checkpoint=${cp}`) && l.includes("action=resolved"));
      out.add(resolved ? "LOST / a stale pending note settled as landed by a change its own label did not cause"
        : `LOST / other: ${w.replace(/^\d+:\d+:/, "")}`);
    }
  }
  return [...out];
}

// ------------------------------------------------------------------------------------------------ distinct violations
/** One contact, one card, quick #07, crons on the minute: only the faults named make anything unusual. */
const world = (c: Partial<ContactCfg>, faults: Fault[], over: Partial<Cfg> = {}): Cfg => ({
  seed: 424242, klass: "explicit",
  contacts: [{ id: "9001", item: "5551", owner: "77", assigned: T0, created: T0 - 10 * MIN, term: "docusign",
    registryHit: true, cardBornAt: T0 - 60 * MIN, cell: { label: null, changedAt: null, phantom: "" }, ...c }],
  wf: { on: true, delayMs: 5 * SEC }, jitter: ALL_RUNS.map(() => 0), indexLagMs: 0, skewMs: 0, hsFormat: "iso",
  faults, ...over,
});
const emailsFor = (W: World, key: string) => W.emails.filter(e => e.key === key).length;

/**
 * THE LAPSED LOCK. Run 1 (T0+35) takes 2.5 min to read the card and monday's user list (one 100 s answer, one 50 s),
 * renews the lock at ~T0+37:31 and notes "pending"; then its clear (the card still shows an earlier cycle's
 * 30分钟未跟进) and its label take ~7.8 min more: two clear attempts that fail at Cloudflare's 100 s 524 limit, a third
 * that lands after 100 s (setColumns' retries=3, 1.5 + 3 s back-off), a label refused at once (retry_in_seconds 64,
 * gql waits 65 s) and its one re-send, answered after 100 s. The 6-minute hold runs out at ~T0+43:31; run 3 (T0+45)
 * takes the lock, finds the note stale (7.5 min), reads the card -- cleared, no label -- and flags it: email 1.
 * Then run 1's re-send comes back.
 */
const lapsed = (lastLabel: Fault): Cfg => world({ assigned: T0 + 4 * MIN, cell: { label: L30, changedAt: T0 - 180 * MIN, phantom: "" } }, [
  { run: 1, match: "monday.readCells", kind: "H", ms: 100 * SEC },
  { run: 1, match: "monday.users", kind: "H", ms: 50 * SEC },
  { run: 1, match: "monday.clear", nth: 0, kind: "A", ms: 100 * SEC },
  { run: 1, match: "monday.clear", nth: 1, kind: "A", ms: 100 * SEC },
  { run: 1, match: "monday.clear", nth: 2, kind: "H", ms: 100 * SEC },
  { run: 1, match: "monday.label", nth: 0, kind: "E", ms: 500, retryIn: 64 },
  lastLabel,
]);
const K30_LAPSED = `9001:${T0 + 4 * MIN}:30`;

describe("adversary: distinct violations, as explicit minimal schedules", () => {
  it("LAPSED LOCK, release: a run whose write outlived its lock RELEASES the note a newer run marked sent -> a SECOND email", async () => {
    const cfg = lapsed({ run: 1, match: "monday.label", nth: 1, kind: "E", ms: 100 * SEC, retryIn: 64 });
    const W = await simulate(cfg);
    if (emailsFor(W, K30_LAPSED) !== 1) await report("LAPSED LOCK, release", cfg, (_c, w) => doubles(w));
    expect(emailsFor(W, K30_LAPSED),
      "AT MOST ONE EMAIL for 9001's 30-minute reminder: a run that lost its lock mid-write must not release (\"\") a note a newer run has since marked sent")
      .toBe(1);
  });

  it("LAPSED LOCK, late label: the same overrun, its label re-send LANDS after the newer run's flag -> a SECOND email", async () => {
    const cfg = lapsed({ run: 1, match: "monday.label", nth: 1, kind: "H", ms: 100 * SEC });
    const W = await simulate(cfg);
    if (emailsFor(W, K30_LAPSED) !== 1) await report("LAPSED LOCK, late label", cfg, (_c, w) => doubles(w));
    expect(emailsFor(W, K30_LAPSED),
      "AT MOST ONE EMAIL for 9001's 30-minute reminder: no label may reach the card after the run's lock has passed to another run")
      .toBe(1);
  });

  it("LAPSED LOCK, in flight: the newer run reads the card while the overrun's label is still on its way, and flags too -> a SECOND email", async () => {
    // run 1's re-sent label lands at ~T0+45:10 (88 s); run 3 read the card at ~T0+45:01, before it, and its own label
    // (40 s) lands after #07 has already turned run 1's into 已提醒.
    const cfg = lapsed({ run: 1, match: "monday.label", nth: 1, kind: "H", ms: 88 * SEC });
    cfg.faults.push({ run: 3, match: "monday.label", kind: "H", ms: 40 * SEC });
    const W = await simulate(cfg);
    if (emailsFor(W, K30_LAPSED) !== 1) await report("LAPSED LOCK, in flight", cfg, (_c, w) => doubles(w));
    expect(emailsFor(W, K30_LAPSED),
      "AT MOST ONE EMAIL for 9001's 30-minute reminder: a stale pending note must not be judged from the card while its writer's label may still land")
      .toBe(1);
  });

  it("control: the same slow monday, but the write ends inside the 6-minute hold -> one email", async () => {
    const cfg = world({ assigned: T0 + 4 * MIN, cell: { label: L30, changedAt: T0 - 180 * MIN, phantom: "" } }, [
      { run: 1, match: "monday.readCells", kind: "H", ms: 100 * SEC },
      { run: 1, match: "monday.clear", nth: 0, kind: "A", ms: 100 * SEC },
      { run: 1, match: "monday.clear", nth: 1, kind: "H", ms: 100 * SEC },
      { run: 1, match: "monday.label", nth: 0, kind: "E", ms: 500, retryIn: 64 },
      { run: 1, match: "monday.label", nth: 1, kind: "E", ms: 60 * SEC, retryIn: 64 },
    ]);
    const W = await simulate(cfg);
    expect(emailsFor(W, K30_LAPSED)).toBe(1);
  });

  /**
   * THE LATE CLEAR. The card still shows an earlier cycle's 30分钟未跟进, so run 0 clears it first -- through setColumns,
   * which RE-SENDS: its first clear gets no reply for 70 s (a 524) and COMMITS 30 s after that; the re-sent clear lands,
   * the label lands, #07 emails and sets 已提醒 -- and then the first clear commits, emptying the cell. "sent" is never
   * noted (the run dies right after its label -- a deploy -- or the note's save fails). The next run with the lock reads
   * the stale "pending" against an EMPTY card -- "it never landed" -- and flags again.
   */
  for (const [how, last] of [["the run dies after its label applied", { run: 0, match: "monday.label", kind: "D" }],
      ["the 'sent' note's save fails", { run: 0, match: '"sent:', kind: "A" }]] as [string, Fault][]) {
    it(`LATE CLEAR (${how}): a re-sent clear's first attempt commits after the label and #07, erasing the proof it landed -> a SECOND email`, async () => {
      const cfg = world({ cell: { label: L30, changedAt: T0 - 180 * MIN, phantom: "" } },
        [{ run: 0, match: "monday.clear", nth: 0, kind: "G", ms: 70 * SEC, late: 30 * SEC }, last],
        { wf: { on: true, delayMs: 10 * SEC } });
      const W = await simulate(cfg);
      const key = `9001:${T0}:30`;
      if (emailsFor(W, key) !== 1) await report(`LATE CLEAR (${how})`, cfg, (_c, w) => doubles(w));
      expect(emailsFor(W, key),
        "AT MOST ONE EMAIL for 9001's 30-minute reminder: a clear that commits late must not erase the proof that the label landed")
        .toBe(1);
    });
  }

  /**
   * THE SETTLE WINDOW COUNTS FROM THE NOTE, NOT FROM THE LABEL. Run 0 notes "pending" at ~T0+30:03; its label is refused
   * after 96 s (retry_in_seconds 64: gql waits 65 s), re-sent at ~T0+32:44, gets no reply for 100 s (a 524 at
   * ~T0+34:24: "unresolved", the run ends and releases its lock) -- and monday commits it 60 s later, ~T0+35:24. Run 1
   * (T0+35:00) finds the note 4.9 min old -- past PENDING_SETTLE_MS -- reads the card before that commit, and flags.
   */
  it("LATE LABEL COMMIT: the label's re-send commits after the next run judged the note stale and the card empty -> a SECOND email", async () => {
    const cfg = world({}, [
      { run: 0, match: "monday.label", nth: 0, kind: "E", ms: 96 * SEC, retryIn: 64 },
      { run: 0, match: "monday.label", nth: 1, kind: "G", ms: 100 * SEC, late: 60 * SEC },
    ]);
    const W = await simulate(cfg);
    const key = `9001:${T0}:30`;
    if (emailsFor(W, key) !== 1) await report("LATE LABEL COMMIT", cfg, (_c, w) => doubles(w));
    expect(emailsFor(W, key),
      "AT MOST ONE EMAIL for 9001's 30-minute reminder: a pending note must not be judged from the card while its label (sent minutes after the note) may still commit")
      .toBe(1);
  });

  it("LATE LABEL COMMIT after a slow clear: the note ages during the clear, the label commits after the next run flagged -> a SECOND email", async () => {
    // The clear is refused after 96 s (gql waits 65 s), its re-send lands at ~T0+32:45, the label goes out then and gets
    // a 524 after 100 s; monday commits it at ~T0+35:25, after run 1 read the card at ~T0+35:00.
    const cfg = world({ cell: { label: L30, changedAt: T0 - 180 * MIN, phantom: "" } }, [
      { run: 0, match: "monday.clear", nth: 0, kind: "E", ms: 96 * SEC, retryIn: 64 },
      { run: 0, match: "monday.label", nth: 0, kind: "G", ms: 100 * SEC, late: 60 * SEC },
    ]);
    const W = await simulate(cfg);
    const key = `9001:${T0}:30`;
    if (emailsFor(W, key) !== 1) await report("LATE LABEL COMMIT after a slow clear", cfg, (_c, w) => doubles(w));
    expect(emailsFor(W, key),
      "AT MOST ONE EMAIL for 9001's 30-minute reminder: a pending note must not be judged from the card while its label (sent minutes after the note) may still commit")
      .toBe(1);
  });

  it("control: the first clear's reply is lost but it commits at once (no late commit) -> one email", async () => {
    const cfg = world({ cell: { label: L30, changedAt: T0 - 180 * MIN, phantom: "" } },
      [{ run: 0, match: "monday.clear", nth: 0, kind: "B" }, { run: 0, match: "monday.label", kind: "D" }],
      { wf: { on: true, delayMs: 10 * SEC } });
    expect(emailsFor(await simulate(cfg), `9001:${T0}:30`)).toBe(1);
  });

  /**
   * #07'S 已提醒 FOR THE 30 READ AS THE 60 HAVING LANDED. The card is created late (T0+54), so the 30-minute reminder
   * goes out at T0+55 and #07 -- slow today, 6 min -- sets 已提醒 at ~T0+61. Run 6 (T0+60) flags the 60: notes
   * "pending" at ~T0+60:01, and its label write fails without landing (a 500). Run 7 reads the stale note against a
   * card whose 跟进提醒 changed at ~T0+61 -- #07's 已提醒 for the 30 -- and counts the 60 as landed: noted sent, never
   * written. Nobody is reminded at 60.
   */
  const slow07 = (delayMs: number) => world({ assigned: T0 - 270 * SEC, cardBornAt: T0 + 54 * MIN },
    [{ run: 6, match: "monday.label", kind: "A" }], { wf: { on: true, delayMs } });
  const K60_SLOW = `9001:${T0 - 270 * SEC}:60`;

  it("SLOW #07: its 已提醒 for the 30 is taken as the 60's label having landed -> the 60-minute reminder is LOST", async () => {
    const cfg = slow07(6 * MIN);
    const W = await simulate(cfg);
    if (emailsFor(W, K60_SLOW) !== 1) await report("SLOW #07 attributes 已提醒", cfg, (c, w) => losses(c, w));
    expect(emailsFor(W, K60_SLOW),
      "the 60-minute reminder is emailed exactly once: a stale pending note may be settled only by a change THIS key's label caused, not by #07 finishing the 30")
      .toBe(1);
  });

  /**
   * THE 5 s SKEW WINDOW. Same world, #07 takes ~5 min: its 已提醒 for the 30 lands at ~T0+60:00, run 6 READS it, then
   * notes the 60 "pending" ~2 s later -- and that note's save persists but its reply is lost, so no label is sent. Run 7
   * counts the 已提醒 run 6 had itself seen before deciding as the 60 having landed (changed_at >= note - 5 s).
   */
  it("SKEW WINDOW: a 已提醒 the deciding run had already SEEN is taken as its own label landing -> the 60-minute reminder is LOST", async () => {
    const cfg = world({ assigned: T0 - 270 * SEC, cardBornAt: T0 + 54 * MIN },
      [{ run: 6, match: '"pending:', kind: "B" }], { wf: { on: true, delayMs: 298 * SEC } });
    const W = await simulate(cfg);
    if (emailsFor(W, K60_SLOW) !== 1) await report("SKEW WINDOW", cfg, (c, w) => losses(c, w));
    expect(emailsFor(W, K60_SLOW),
      "the 60-minute reminder is emailed exactly once: a change the deciding run read before noting 'pending' is not its label landing")
      .toBe(1);
  });

  it("control: the same schedule with a quick #07 -> the 60-minute reminder goes out once", async () => {
    const W = await simulate(slow07(5 * SEC));
    expect(emailsFor(W, K60_SLOW)).toBe(1);
    expect(emailsFor(W, `9001:${T0 - 270 * SEC}:30`)).toBe(1);
  });
});

/** ADV_SCALE scales every sweep's seed count (default 1). */
const SCALE = Number(process.env.ADV_SCALE ?? 1);
describe("adversary: random fault schedules", () => {
  /**
   * Run `n` seeds; minimise up to `keep` violating ones, classify each from its trace, print one trace per class.
   * `out`: one line per class -- its seeds and the first one's minimal fault schedule.
   */
  const sweep = async (name: string, gen: (s: number) => Cfg, n: number, check: (c: Cfg, W: World) => string[],
      keep = 25) => {
    const seeds = Math.max(1, Math.ceil(n * SCALE));
    const started = real.now();
    const bad: { cfg: Cfg; why: string[] }[] = [];
    let emails = 0;
    const m: Record<string, number> = {};
    for (let s = 1; s <= seeds; s++) {
      const cfg = gen(s);
      const W = await simulate(cfg);
      emails += W.emails.length;
      for (const [k, v] of Object.entries(W.m)) m[k] = (m[k] ?? 0) + v;
      if (W.anomalies.length) m["ANOMALY " + W.anomalies[0].slice(0, 60)] = (m["ANOMALY " + W.anomalies[0].slice(0, 60)] ?? 0) + 1;
      if (cfg.contacts.every(c => c.activityAt === undefined && !c.reassign && c.cardBornAt <= T0 + 54 * MIN) && cfg.wf.on) {
        m["(info) due checkpoints"] = (m["(info) due checkpoints"] ?? 0) + cfg.contacts.length * 2;
        const lost = losses(cfg, W).filter(x => / 0 email/.test(x)).length;
        if (lost) m["(info) due checkpoints never emailed"] = (m["(info) due checkpoints never emailed"] ?? 0) + lost;
      }
      const why = check(cfg, W);
      if (why.length) bad.push({ cfg, why });
    }
    real.log(`[adversary] ${name} path coverage:\n  ${Object.entries(m).sort().map(([k, v]) => `${k}: ${v}`).join("\n  ")}`);
    real.log(`[adversary] ${name}: ${seeds} seeds in ${((real.now() - started) / 1000).toFixed(1)} s, ${emails} emails, ${bad.length} violating seed(s): ${bad.slice(0, 80).map(b => b.cfg.seed).join(",")}`);
    const classes = new Map<string, { seeds: number[]; first: Cfg; faults: string }>();
    for (const b of bad.slice(0, keep)) {
      const min = await minimise(b.cfg, (c, W) => check(c, W).length > 0);
      const W = await simulate({ ...min, trace: true });
      const faults = `${min.faults.map(f => `run ${f.run} call #${f.call} ${f.kind}`).join(", ") || "no explicit fault"}`
        + `${min.incident ? ` + monday incident ${fmt(min.incident.from)}..${fmt(min.incident.to)}${min.incident.severe ? " (severe)" : ""}` : ""}`
        + `${min.wf.delayMs > 60 * SEC ? ` + #07 delay ${(min.wf.delayMs / SEC).toFixed(0)} s` : ""}`;
      for (const k of classify(W, check(min, W))) {
        const c = classes.get(k);
        if (c) c.seeds.push(b.cfg.seed);
        else {
          classes.set(k, { seeds: [b.cfg.seed], first: min, faults });
          await report(`${name}: ${k} -- seed ${b.cfg.seed}, minimised`, min, check);
        }
      }
    }
    const out = [...classes].map(([k, c]) => `${k} -- seeds ${c.seeds.join(",")}`
      + `${bad.length > keep ? ` (first ${keep} of ${bad.length} violating seeds classified)` : ""}; seed ${c.first.seed} minimal: ${c.faults}`);
    return { bad, out };
  };

  it("SAFETY: AT MOST ONE EMAIL per (contact, assignment, checkpoint) -- 3000 seeds of anything-goes faults", async () => {
    const { out } = await sweep("safety", safetyCfg, 3000, (_c, W) => doubles(W));
    expect(out, "at most one email per (contact, assignment, checkpoint), under any fault schedule").toEqual([]);
  }, 1_800_000);

  it("SAFETY: AT MOST ONE EMAIL -- 2000 hostile seeds (clear path, monday incidents, slow calls, jittered crons)", async () => {
    const { out } = await sweep("hostile", hostileCfg, 2000, (_c, W) => doubles(W));
    expect(out, "at most one email per (contact, assignment, checkpoint), under any fault schedule").toEqual([]);
  }, 1_800_000);

  it("SAFETY: AT MOST ONE EMAIL -- 2000 severe seeds (monday at the 524 edge, late commits, very slow calls)", async () => {
    const { out } = await sweep("severe", severeCfg, 2000, (_c, W) => doubles(W));
    expect(out, "at most one email per (contact, assignment, checkpoint), under any fault schedule").toEqual([]);
  }, 1_800_000);

  it("LIVENESS: few transient faults, #07 on -- each due checkpoint emailed EXACTLY once in its window -- 2000 seeds", async () => {
    const { out } = await sweep("liveness", livenessCfg, 2000, (c, W) => [...doubles(W), ...losses(c, W)]);
    expect(out, "each due checkpoint emailed exactly once within its window when faults are few and transient").toEqual([]);
  }, 1_800_000);

  it("LIVENESS with a SLOW #07 (up to 8 min) -- each due checkpoint emailed EXACTLY once in its window -- 2000 seeds", async () => {
    const { out } = await sweep("liveness-slow-07", livenessSlowCfg, 2000, (c, W) => [...doubles(W), ...losses(c, W)]);
    expect(out, "each due checkpoint emailed exactly once within its window when faults are few and transient, #07 on").toEqual([]);
  }, 1_800_000);

  it("LIVENESS with LATE CARDS and a slow #07 -- each due checkpoint emailed EXACTLY once in its window -- 2000 seeds", async () => {
    const { out } = await sweep("liveness-late-card", livenessLateCfg, 2000, (c, W) => [...doubles(W), ...losses(c, W)]);
    expect(out, "each due checkpoint emailed exactly once within its window when faults are few and transient, #07 on").toEqual([]);
  }, 1_800_000);
});
