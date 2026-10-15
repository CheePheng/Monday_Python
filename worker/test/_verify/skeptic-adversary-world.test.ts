import { describe, it, expect, vi } from "vitest";
import type { RunOpts } from "../../src/types";

/**
 * SKEPTIC of the adversary's ADV-1..4 -- an INDEPENDENT harness, not the adversary's simulator.
 *
 * REAL: follow-up-reminder.ts, owner-notice.ts's helpers, monday.ts's gql / setColumns / getUsersByEmail over a stubbed
 * global fetch, activity-registry.ts over the REAL CreateIdempotency class (one instance per DO name, serialised like
 * blockConcurrencyWhile). STUBBED: hubspot.ts hs and card-registry.ts lookupCard.
 *
 * A virtual clock drives everything (gql's own setTimeout waits included). Faults are scripted per run and per call and
 * restricted to behaviours that occur in production, each on its own: a 500; a FAST 429 carrying retry_in_seconds; an
 * answer just under Cloudflare's 100 s edge; a gateway timeout whose write monday commits later (the module's own
 * comment at follow-up-reminder.ts:80-81 allows this); a reply lost after the write applied; a DO reply lost after the
 * write persisted. NO slow 429s (the adversary's 'release' and 'LATE LABEL COMMIT' tests use a 429 that takes 96-100 s).
 *
 * #07: on every CHANGE INTO 30分钟未跟进 / 60分钟未跟进 it emails after `wfDelay`, then sets 已提醒. Writing the value a
 * cell holds changes nothing and fires nothing; a clear fires nothing. One contact, one assignment: emails per label
 * are emails per (contact, assignment, checkpoint).
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
vi.mock("../../src/sync", () => ({}));
const hooks = vi.hoisted(() => ({
  hs: (..._a: any[]): Promise<any> => Promise.reject(new Error("no world")),
  lookupCard: (..._a: any[]): Promise<string | null> => Promise.reject(new Error("no world")),
}));
vi.mock("../../src/hubspot", async (orig) => ({ ...(await orig<any>()), hs: (...a: any[]) => hooks.hs(...a) }));
vi.mock("../../src/card-registry", async (orig) => ({
  ...(await orig<any>()), lookupCard: (...a: any[]) => hooks.lookupCard(...a),
}));

const { CreateIdempotency } = await import("../../src/create-idempotency-do");
const FUR = await import("../../src/follow-up-reminder");

const SEC = 1_000, MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const STATUS = "color_mm82ccsb", OWNER_COL = "multiple_person_mm6zap53";
const L30 = "30分钟未跟进", L60 = "60分钟未跟进", DONE = "已提醒";
const INDEX: Record<string, number> = { [L30]: 0, [DONE]: 1, [L60]: 2 };
const LIVE: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const realSetImmediate = globalThis.setImmediate;
const drain = () => new Promise<void>(r => realSetImmediate(() => r()));

type Kind = "readCells" | "users" | "find" | "clear" | "label" | "other";
/** One monday call. `ms`: when monday answers (for "late": when the gateway gives up; the write commits `late` after). */
interface Beh { ms?: number; out?: "ok" | "500" | "throw" | "429" | "late" | "lost"; retryIn?: number; late?: number }
interface Cfg {
  assigned: number; created: number; cardBornAt: number;
  cell: { label: string | null; changedAt: number | null };
  wfDelay: number;
  /** `${run}:${kind}` -> that run's 1st, 2nd, ... call of that kind (default: ok after 300 ms) */
  monday?: Record<string, Beh[]>;
  /** `${run}:${tag}` (pending | sent | release | renewLock | ...) -> "fail" (not applied) | "lost" (persisted, reply lost) */
  dos?: Record<string, "fail" | "lost">;
}
interface Run { idx: number; env: any; counts: Record<string, number>; ended?: boolean }

const fmt = (t: number) => {
  const d = t - T0;
  return `T0+${String(Math.floor(d / MIN)).padStart(2, "0")}:${((d % MIN) / SEC).toFixed(3).padStart(6, "0")}`;
};

async function simulate(cfg: Cfg) {
  const q: { t: number; s: number; fn: () => void }[] = [];
  let now = T0 + 29 * MIN, seq = 0;
  const at = (t: number, fn: () => void) => { q.push({ t: Math.max(t, now), s: seq++, fn }); };
  const after = (ms: number, fn: () => void) => at(now + Math.max(0, Math.round(ms)), fn);
  const lines: string[] = [];
  const tr = (s: string) => { lines.push(`${fmt(now)} ${s}`); };
  const emails: { label: string; at: number }[] = [];
  const marks: Record<string, number> = {};
  const cell = { ...cfg.cell };
  const runs: Run[] = [];
  const byToken = new Map<string, Run>(), byEnv = new Map<any, Run>();

  // ---- the card and workflow #07
  const write = (label: string | null, who: string) => {
    if (now < cfg.cardBornAt) throw new Error("no such item");
    if (label === cell.label) { tr(`   board: ${who} writes ${label ?? "empty"} -> NO CHANGE`); return; }
    tr(`   board: ${who}: ${cell.label ?? "empty"} -> ${label ?? "empty"}${label === L30 || label === L60 ? "   ** #07 fires **" : ""}`);
    cell.label = label; cell.changedAt = label === null ? null : now;
    if (label === L30 || label === L60) {
      after(cfg.wfDelay, () => {
        emails.push({ label, at: now });
        tr(`#07 EMAILS the owner for ${label}; sets ${DONE}`);
        if (cell.label !== DONE) { cell.label = DONE; cell.changedAt = now; }
      });
    }
  };
  const board = (query: string, vars: any, who: string): any => {
    if (/change_multiple_column_values/.test(query)) {
      const v = JSON.parse(vars.c)[STATUS];
      write(v === null ? null : String(v.label), who);
      return { change_multiple_column_values: { id: String(vars.i) } };
    }
    if (/users\s*\(/.test(query)) return { users: [{ id: "501", email: "o77@example.test" }] };
    if (/items_page_by_column_values/.test(query))
      return { items_page_by_column_values: { items: now >= cfg.cardBornAt ? [{ id: "5551" }] : [] } };
    if (/items\s*\(\s*ids/.test(query)) {
      if (now < cfg.cardBornAt) return { items: [] };
      const status = cell.label
        ? { id: STATUS, text: cell.label, index: INDEX[cell.label], value: JSON.stringify({ index: INDEX[cell.label],
            post_id: null, changed_at: new Date(cell.changedAt!).toISOString() }) }
        : { id: STATUS, text: "", index: null, value: null };
      return { items: [{ column_values: [status,
        { id: OWNER_COL, text: "", value: null, persons_and_teams: [{ id: "501", kind: "person" }] }] }] };
    }
    throw new Error(`unexpected monday query ${query.slice(0, 60)}`);
  };

  // ---- monday over the real gql
  const resp = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300,
    json: async () => { if (body === undefined) throw new SyntaxError("Unexpected token <"); return body; } });
  const mondayFetch = (_u: unknown, init: any): Promise<any> => {
    const run = byToken.get(init?.headers?.Authorization)!;
    const { query, variables } = JSON.parse(init.body);
    const kind: Kind = /change_multiple_column_values/.test(query)
      ? (JSON.parse(variables.c)[STATUS] === null ? "clear" : "label")
      : /users\s*\(/.test(query) ? "users" : /items_page_by_column_values/.test(query) ? "find"
      : /items\s*\(\s*ids/.test(query) ? "readCells" : "other";
    const n = run.counts[kind] = (run.counts[kind] ?? -1) + 1;
    const b: Beh = cfg.monday?.[`${run.idx}:${kind}`]?.[n] ?? {};
    const ms = b.ms ?? 300, out = b.out ?? "ok";
    const who = `R${run.idx} ${kind}#${n}`;
    if (kind === "label") marks[`R${run.idx} label#${n} sent`] = now;
    tr(`${who} sent${out !== "ok" || ms !== 300 ? `   [${out} after ${ms / SEC} s${out === "late" ? `, commits ${(b.late ?? 0) / SEC} s later` : ""}]` : ""}`);
    return new Promise((res, rej) => {
      if (out === "late") {
        after(ms, () => { tr(`${who}: gateway timeout (524), no reply`); res(resp(524, undefined)); });
        after(ms + (b.late ?? 0), () => { tr(`${who}: COMMITS LATE`); board(query, variables, who); });
        return;
      }
      after(ms, () => {
        if (out === "500") { tr(`${who}: 500, not applied`); res(resp(500, { error_message: "Internal Server Error" })); return; }
        if (out === "throw") { tr(`${who}: fetch failed, not applied`); rej(new TypeError("fetch failed")); return; }
        if (out === "429") {
          tr(`${who}: 429 retry_in_seconds ${b.retryIn ?? 30}, not applied`);
          res(resp(429, { errors: [{ message: "Complexity budget exhausted",
            extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED", retry_in_seconds: b.retryIn ?? 30 } }] }));
          return;
        }
        let data: any;
        try { data = board(query, variables, who); }
        catch (e) { res(resp(200, { errors: [{ message: String(e) }] })); return; }
        if (kind === "label") marks[`R${run.idx} label#${n} landed`] = now;
        if (out === "lost") { tr(`${who}: applied, reply LOST (504)`); res(resp(504, { error_message: "Gateway Timeout" })); return; }
        res(resp(200, { data }));
      });
    });
  };

  // ---- Durable Objects: the real class
  const dos = new Map<string, any>();
  const inst = (name: string) => {
    let d = dos.get(name);
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
        blockConcurrencyWhile: (fn: () => Promise<any>) => {
          const p = chain.then(() => fn()); chain = p.catch(() => undefined); return p;
        },
      };
      d = new (CreateIdempotency as any)(ctx, {});
      dos.set(name, d);
    }
    return d;
  };
  const doCall = (run: Run, name: string, method: string, args: any[]): Promise<any> => {
    const tag = method === "rememberPermanent" && name.startsWith("wm:fur:")
      ? (String(args[0]).startsWith("pending:") ? "pending" : String(args[0]).startsWith("sent:") ? "sent" : "release")
      : method;
    const f = cfg.dos?.[`${run.idx}:${tag}`];
    return new Promise((res, rej) => {
      after(15, async () => {
        if (f === "fail") {
          tr(`R${run.idx} DO ${tag}: FAILED, not applied`);
          after(5, () => rej(new Error("Durable Object reset because its code was updated")));
          return;
        }
        let out: any, err: any;
        try { out = await inst(name)[method](...args); } catch (e) { err = e; }
        if (tag !== "getCard")
          tr(`R${run.idx} DO ${tag}${method === "rememberPermanent" ? ` "${args[0]}"` : ""} -> ${err ? `throws ${err}` : JSON.stringify(out)}`);
        if (tag === "renewLock" && out === true) marks[`R${run.idx} renewed`] = now;
        if (tag === "pending") marks[`R${run.idx} pending`] = now;
        if (f === "lost") {
          tr(`R${run.idx} DO ${tag}: persisted, reply LOST`);
          after(5, () => rej(new Error("Network connection lost")));
          return;
        }
        after(5, () => (err ? rej(err) : res(out)));
      });
    });
  };

  // ---- HubSpot and the card registry
  const props = () => ({ hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(cfg.assigned).toISOString(),
    createdate: new Date(cfg.created).toISOString(), utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: null });
  const hsFn = (method: string, path: string, body?: any): Promise<any> => new Promise(res => after(100, () => {
    if (method === "POST") {
      const ok = (body.filterGroups[0].filters as any[]).every(x =>
        x.propertyName === "hubspot_owner_assigneddate"
          ? (x.operator === "GTE" ? cfg.assigned >= Number(x.value) : cfg.assigned <= Number(x.value))
          : x.propertyName === "createdate" ? cfg.created >= Number(x.value) : true);
      res({ total: ok ? 1 : 0, results: ok ? [{ id: "9001", properties: props() }] : [] });
      return;
    }
    if (path.startsWith("/crm/v3/owners/")) { res({ id: "77", email: "o77@example.test" }); return; }
    res({ id: "9001", properties: props() });
  }));

  // ---- crons, every 5 minutes on the minute
  for (let k = 0; k < 14; k++) at(T0 + (30 + 5 * k) * MIN, () => {
    const run: Run = { idx: k, env: null, counts: {} };
    run.env = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: `tok-${k}`, HUBSPOT_ACCESS_TOKEN: "hs",
      CREATE_IDEMPOTENCY: { idFromName: (n: string) => n,
        get: (id: string) => new Proxy({}, { get: (_t, m) => (m === "then" ? undefined
          : (...a: any[]) => doCall(run, id, String(m), a)) }) } };
    runs.push(run); byToken.set(run.env.MONDAY_API_TOKEN, run); byEnv.set(run.env, run);
    tr(`== run ${k} starts`);
    FUR.runFollowUpReminders(run.env, LIVE).then(
      s => { run.ended = true; tr(`== run ${k} ends ${JSON.stringify(s)}`); },
      e => { run.ended = true; tr(`== run ${k} THREW ${String(e)}`); });
  });

  const real = { setTimeout: globalThis.setTimeout, fetch: globalThis.fetch, now: Date.now, log: console.log };
  (globalThis as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => { after(ms ?? 0, () => fn(...a)); return 0; };
  (globalThis as any).fetch = mondayFetch;
  Date.now = () => now;
  console.log = (...a: unknown[]) => tr(`   | ${a.map(String).join(" ")}`);
  hooks.hs = (...a: any[]) => hsFn(a[1], a[2], a[3]);
  hooks.lookupCard = (...a: any[]) => new Promise(res => after(10, () => res(now >= cfg.cardBornAt ? "5551" : null)));
  try {
    for (;;) {
      await drain(); await drain();
      if (!q.length) break;
      q.sort((a, b) => a.t - b.t || a.s - b.s);
      const e = q.shift()!;
      if (e.t > T0 + 120 * MIN) break;
      now = e.t;
      e.fn();
    }
  } finally {
    (globalThis as any).setTimeout = real.setTimeout;
    (globalThis as any).fetch = real.fetch;
    Date.now = real.now;
    console.log = real.log;
  }
  const count = (label: string) => emails.filter(e => e.label === label).length;
  return { emails, count, lines, marks, cell };
}

/** The card shows an EARLIER cycle's 30分钟未跟进 that #07 never turned into 已提醒: the clear path. */
const STUCK30 = { label: L30, changedAt: T0 - 180 * MIN };
const base = (o: Partial<Cfg>): Cfg => ({ assigned: T0, created: T0 - 10 * MIN, cardBornAt: T0 - 60 * MIN,
  cell: { label: null, changedAt: null }, wfDelay: 5 * SEC, ...o });
const show = (title: string, w: { lines: string[] }) => console.log(`===== ${title}\n${w.lines.map(l => `  ${l}`).join("\n")}`);

describe("skeptic: controls on the independent harness", () => {
  it("no faults: one email at 30, one at 60", async () => {
    const w = await simulate(base({}));
    expect([w.count(L30), w.count(L60)]).toEqual([1, 1]);
  });
  it("no faults, card on the clear path (earlier cycle's 30 stuck): still one email at 30, one at 60", async () => {
    const w = await simulate(base({ cell: STUCK30 }));
    expect([w.count(L30), w.count(L60)]).toEqual([1, 1]);
  });
});

describe("skeptic ADV-1: one card's write outlives RUN_LOCK_HOLD_MS -- with FAST 429s only", () => {
  /**
   * monday incident during run 1 (T0+35): every call answers at 99 s (just under the 524 edge), one read and two clear
   * attempts fail with a 500, the label's first attempt is refused AT ONCE (429, retry_in_seconds 64). Run 3's calls
   * (T0+45) are normal. The card is on the clear path. Nothing here is a slow 429.
   */
  const lateLabel = (): Cfg => base({ assigned: T0 + 4 * MIN, cell: STUCK30, monday: {
    "1:readCells": [{ out: "500", ms: 99 * SEC }, { ms: 99 * SEC }],
    "1:users": [{ ms: 20 * SEC }],
    "1:clear": [{ out: "500", ms: 99 * SEC }, { out: "500", ms: 99 * SEC }, { ms: 99 * SEC }],
    "1:label": [{ out: "429", ms: 300, retryIn: 64 }, { ms: 99 * SEC }],
  } });

  it("premise: run 1's write phase (renew -> label landed) is longer than the lock's 6-minute hold", async () => {
    const w = await simulate(lateLabel());
    const phase = w.marks["R1 label#1 landed"] - w.marks["R1 renewed"];
    console.log(`[skeptic] run 1 renewed at ${fmt(w.marks["R1 renewed"])}, label landed at ${fmt(w.marks["R1 label#1 landed"])}: ${(phase / SEC).toFixed(1)} s vs hold ${FUR.RUN_LOCK_HOLD_MS / SEC} s`);
    expect(phase).toBeGreaterThan(FUR.RUN_LOCK_HOLD_MS);
  });

  it("LATE LABEL (fast 429s): the overrun's label lands after run 3 flagged -> AT MOST ONE EMAIL", async () => {
    const w = await simulate(lateLabel());
    if (w.count(L30) !== 1) show("ADV-1 late label, fast 429s", w);
    expect(w.count(L30), "AT MOST ONE EMAIL for the 30-minute reminder: a run whose lock lapsed mid-write must not land a label after another run flagged").toBe(1);
  });

  it("RELEASE (fast 429s, renew aligned 5 s before a cron boundary + 6 min): the overrun's release wipes run 3's 'sent' -> AT MOST ONE EMAIL", async () => {
    const w = await simulate(base({ assigned: T0 + 4 * MIN, cell: STUCK30, monday: {
      "1:readCells": [{ out: "500", ms: 100 * SEC }, { ms: 100 * SEC }],
      "1:users": [{ ms: 33 * SEC }],
      "1:clear": [{ out: "500", ms: 100 * SEC }, { out: "500", ms: 100 * SEC }, { ms: 100 * SEC }],
      "1:label": [{ out: "429", ms: 300, retryIn: 64 }, { out: "429", ms: 300, retryIn: 64 }],
    } }));
    if (w.count(L30) !== 1) show("ADV-1 release, fast 429s", w);
    expect(w.count(L30), "AT MOST ONE EMAIL for the 30-minute reminder: an overrun's release must not erase a newer run's 'sent'").toBe(1);
  });

  it("control: the same incident WITHOUT the clear path (card empty) stays inside the hold -> one email", async () => {
    const cfg = lateLabel();
    cfg.cell = { label: null, changedAt: null };
    const w = await simulate(cfg);
    expect(w.count(L30)).toBe(1);
  });

  it("calibration: if monday never answers later than 60 s and 429s are fast, the WORST clear-path write stays inside the hold", async () => {
    // Worst successful clear (fail 60 s, fast 429 + 65 s wait, ok 60 s) then the worst label (fast 429 + 65 s, ok 60 s).
    const w = await simulate(base({ assigned: T0 + 4 * MIN, cell: STUCK30, monday: {
      "1:clear": [{ out: "500", ms: 60 * SEC }, { out: "429", ms: 300, retryIn: 64 }, { ms: 60 * SEC }],
      "1:label": [{ out: "429", ms: 300, retryIn: 64 }, { ms: 60 * SEC }],
    } }));
    const phase = w.marks["R1 label#1 landed"] - w.marks["R1 renewed"];
    console.log(`[skeptic] 60 s cap, fast 429s: write phase ${(phase / SEC).toFixed(1)} s vs hold ${FUR.RUN_LOCK_HOLD_MS / SEC} s`);
    expect(phase).toBeLessThan(FUR.RUN_LOCK_HOLD_MS);
    expect(w.count(L30)).toBe(1);
  });
});

describe("skeptic ADV-3: the settle window counts from the note, not from the label's last send -- FAST 429, no clear path", () => {
  /**
   * Run 0 (T0+30): readCells answers at 98 s (incident), so the note is stamped at ~T0+31:48. The label is refused AT
   * ONCE (429, retry_in_seconds 59: gql waits 60 s); the re-send gets a 524 at 100 s (~T0+34:29: "unresolved", the run
   * ends and frees the lock) and monday commits it 45 s later (~T0+35:14). Run 1 (T0+35:00) reads a 3.2-min-old note and
   * an empty card.
   */
  const settle = (late: number): Cfg => base({ monday: {
    "0:readCells": [{ ms: 98 * SEC }],
    "0:users": [{ ms: 10 * SEC }],
    "0:label": [{ out: "429", ms: 300, retryIn: 59 }, { out: "late", ms: 100 * SEC, late }],
  } });

  it("LATE LABEL COMMIT (fast 429): -> AT MOST ONE EMAIL", async () => {
    const w = await simulate(settle(45 * SEC));
    if (w.count(L30) !== 1) show("ADV-3 late label commit, fast 429", w);
    expect(w.count(L30), "AT MOST ONE EMAIL for the 30-minute reminder: a pending note must not be judged from the card while its label's last send may still commit").toBe(1);
  });

  it("control: the same, monday commits 20 s after the 524 (before run 1) -> one email", async () => {
    const w = await simulate(settle(20 * SEC));
    expect(w.count(L30)).toBe(1);
  });

  /** Calibration under a 60 s per-call cap: a read retried (fail 60 s, ok 50 s), a fast 429, a 504 at 60 s. */
  const capped = (late: number): Cfg => base({ monday: {
    "0:readCells": [{ out: "500", ms: 60 * SEC }, { ms: 50 * SEC }],
    "0:users": [{ ms: 5 * SEC }],
    "0:label": [{ out: "429", ms: 300, retryIn: 64 }, { out: "late", ms: 60 * SEC, late }],
  } });
  it("calibration, 60 s cap: monday commits 45 s after its 504 -> one email (resolved from the card)", async () => {
    expect((await simulate(capped(45 * SEC))).count(L30)).toBe(1);
  });
  it("calibration, 60 s cap: monday commits 65 s after its 504 -> the double needs a commit ~1 min after the timeout", async () => {
    expect((await simulate(capped(65 * SEC))).count(L30)).toBe(2);
  });
});

describe("skeptic ADV-2: a late-committing clear erases the proof the label landed", () => {
  /**
   * Clear path. Run 0 (T0+30): the first clear gets no reply for 60 s and commits 50 s after that; setColumns re-sends
   * it (lands); the label lands but its reply is lost (504) -> "unresolved"; #07 emails (10 s) and sets 已提醒; then
   * the first clear commits and empties the cell. All monday-side, one incident. No DO failure, no dead invocation.
   */
  const lateClear = (labelOut: Beh["out"]): Cfg => base({ cell: STUCK30, wfDelay: 10 * SEC, monday: {
    "0:clear": [{ out: "late", ms: 60 * SEC, late: 50 * SEC }, {}],
    "0:label": [{ out: labelOut }],
  } });

  it("LATE CLEAR + the label's reply lost -> AT MOST ONE EMAIL", async () => {
    const w = await simulate(lateClear("lost"));
    if (w.count(L30) !== 1) show("ADV-2 late clear, label reply lost", w);
    expect(w.count(L30), "AT MOST ONE EMAIL for the 30-minute reminder: a clear that commits late must not erase the proof that the label landed").toBe(1);
  });

  it("LATE CLEAR + the 'sent' note's save fails (a DO reset) -> AT MOST ONE EMAIL", async () => {
    const cfg = lateClear("ok");
    cfg.dos = { "0:sent": "fail" };
    const w = await simulate(cfg);
    if (w.count(L30) !== 1) show("ADV-2 late clear, sent save fails", w);
    expect(w.count(L30), "AT MOST ONE EMAIL for the 30-minute reminder: a clear that commits late must not erase the proof that the label landed").toBe(1);
  });

  it("control: the same late clear, but the label's reply arrives and 'sent' is saved -> one email", async () => {
    const w = await simulate(lateClear("ok"));
    expect(w.count(L30)).toBe(1);
  });
});

describe("skeptic ADV-4: #07's 已提醒 for the 30 read as the 60 having landed", () => {
  /** Card born at T0+54, so the 30 is flagged by the T0+55 run; run 6 (T0+60) flags the 60 and its label fails (500). */
  const slow07 = (wfDelay: number): Cfg => base({ assigned: T0 - 270 * SEC, cardBornAt: T0 + 54 * MIN, wfDelay,
    monday: { "6:label": [{ out: "500" }] } });

  it("SLOW #07 (6 min): the 60-minute reminder is emailed exactly once", async () => {
    const w = await simulate(slow07(6 * MIN));
    if (w.count(L60) !== 1) show("ADV-4 slow #07", w);
    expect(w.count(L60), "the 60-minute reminder is emailed exactly once: a change its own label did not cause must not settle its pending note").toBe(1);
  });

  it("threshold probe: #07 at 4.5 min -> the 60 still goes out once (the loss needs #07 to lag ~4.9 min or more)", async () => {
    const w = await simulate(slow07(4.5 * MIN));
    expect(w.count(L60)).toBe(1);
  });

  it("SKEW WINDOW: #07's 已提醒 lands ~1.5 s before the 60's note, whose save persists but loses its reply -> emailed once", async () => {
    const cfg = base({ assigned: T0 - 270 * SEC, cardBornAt: T0 + 54 * MIN, wfDelay: 298 * SEC, dos: { "6:pending": "lost" } });
    const w = await simulate(cfg);
    if (w.count(L60) !== 1) show("ADV-4 skew window", w);
    expect(w.count(L60), "the 60-minute reminder is emailed exactly once: a change the deciding run had already read is not its label landing").toBe(1);
  });

  it("control: quick #07 (5 s), same failed 60 label -> the 60 goes out once", async () => {
    const w = await simulate(slow07(5 * SEC));
    expect([w.count(L30), w.count(L60)]).toEqual([1, 1]);
  });
});
