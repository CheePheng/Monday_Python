import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import { readCode } from "../scripts/read-source.mjs";

/**
 * THE LAST ACTIVITY BACKSTOP (lad-sweep.ts), driven against an in-memory HubSpot search and an
 * in-memory durable store that implements the real contract -- a watermark read that can THROW, a
 * soft note store, a lock -- because the behaviour under test is how the sweep treats that store.
 */

const store = vi.hoisted(() => {
  const wm = new Map<string, string>();
  const notes = new Map<string, string>();
  const state = { wmThrows: false, setThrows: false, lockFree: true };
  return {
    wm, notes, state,
    getWatermark: vi.fn(async (_e: Env, n: string) => {
      if (state.wmThrows) throw new Error(`watermark ${n} unreadable: boom`);
      return wm.get(n) ?? null;
    }),
    setWatermark: vi.fn(async (_e: Env, n: string, v: string) => {
      if (state.setThrows) throw new Error(`watermark ${n} not saved`);
      wm.set(n, v);
    }),
    readNote: vi.fn(async (_e: Env, n: string) => notes.get(n) ?? null),
    writeNote: vi.fn(async (_e: Env, n: string, v: string) => { notes.set(n, v); return true; }),
    acquireLock: vi.fn(async () => state.lockFree),
    releaseLock: vi.fn(async () => {}),
  };
});
/** HubSpot: per object, the records and their notes_last_updated. The search honours filters + sort + limit. */
const hub = vi.hoisted(() => ({ records: {} as Record<string, { id: string; ts: string }[]>, searches: [] as any[] }));
const hubspot = vi.hoisted(() => ({
  hs: vi.fn(async (_e: Env, _m: string, path: string, body: any) => {
    const object = path.split("/")[4];
    hub.searches.push({ object, body });
    const f = body.filterGroups[0].filters;
    const gte = f.find((x: any) => x.operator === "GTE").value, lte = f.find((x: any) => x.operator === "LTE").value;
    const all = (hub.records[object] ?? []).filter(r => Date.parse(r.ts) >= gte && Date.parse(r.ts) <= lte)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    // HubSpot's search paging: `after` is an offset into the same query's results.
    const from = Number(body.after ?? 0);
    const rows = all.slice(from, from + body.limit);
    const more = from + body.limit < all.length;
    return { results: rows.map(r => ({ id: r.id, properties: { notes_last_updated: r.ts } })),
      ...(more ? { paging: { next: { after: String(from + body.limit) } } } : {}) };
  }),
}));
const sync = vi.hoisted(() => ({
  syncHubspotRecord: vi.fn(async (..._a: any[]) => "action=updated-monday"),
  legacyDealRouting: vi.fn(() => false),
}));
vi.mock("../src/activity-registry", () => store);
vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/sync", () => sync);

const {
  sweepLastActivity, ladSweepGate, LAD_SWEEP_SEED, OVERLAP_MS, SETTLE_MS, MAX_PER_OBJECT, POISON_TRIES,
  POISON_MIN_AGE_MS, watermarkName, seenName, LAD_PROP, sweepOrder, MAX_SYNCS_PER_RUN, MAX_SYNCS_WITH_MARKETING,
  NEW_PAGES, SEARCH_PAGE, sweepDeadline, SWEEP_BUDGET_MS, SWEEP_LATEST_START_MS,
} = await import("../src/lad-sweep");

const live = { ENABLE_CRM: "true", ENABLE_LAD_SWEEP: "true", DRY_RUN: "false", MAX_WRITES: "500" } as unknown as Env;
const NOW = Date.parse("2026-09-30T12:00:00Z");
const at = (min: number) => new Date(Date.parse("2026-09-30T10:00:00Z") + min * 60_000).toISOString();
const synced = (object?: string) => sync.syncHubspotRecord.mock.calls
  .filter(c => !object || (c[1] as any).object === object).map(c => c[2]);

beforeEach(() => {
  vi.clearAllMocks();
  store.wm.clear(); store.notes.clear();
  Object.assign(store.state, { wmThrows: false, setThrows: false, lockFree: true });
  hub.records = {}; hub.searches = [];
  sync.syncHubspotRecord.mockImplementation(async (_e: Env, spec: any, id: string) => `${spec.object}/${id} action=updated-monday`);
  sync.legacyDealRouting.mockReturnValue(false);
});

describe("the gate", () => {
  it("never runs on the Work Management Worker, whatever the flag says", async () => {
    const r = await sweepLastActivity({ ENABLE_LAD_SWEEP: "true", DRY_RUN: "false" } as unknown as Env, { nowMs: NOW });
    expect(r.status).toBe("refused");
    expect(hubspot.hs).not.toHaveBeenCalled();
    expect(store.acquireLock).not.toHaveBeenCalled();
  });

  it.each([undefined, "false", "TRUE", "1", ""])("ENABLE_LAD_SWEEP=%s is off", async (v) => {
    expect(ladSweepGate({ ENABLE_CRM: "true", ENABLE_LAD_SWEEP: v } as unknown as Env).ok).toBe(false);
    const r = await sweepLastActivity({ ENABLE_CRM: "true", ENABLE_LAD_SWEEP: v } as unknown as Env, { nowMs: NOW });
    expect(r.status).toBe("disabled");
    expect(hubspot.hs).not.toHaveBeenCalled();
  });
});

describe("one sweep", () => {
  it("first run: re-checks the overlap behind the seed, then reads NEW WORK from the seed, oldest first, leaving the newest minutes to the webhooks", async () => {
    await sweepLastActivity(live, { nowMs: NOW });
    const [overlap, fresh] = hub.searches.filter(x => x.object === "contacts");
    const seed = Date.parse(LAD_SWEEP_SEED);
    expect(overlap.body.filterGroups[0].filters).toEqual([
      { propertyName: LAD_PROP, operator: "GTE", value: seed - OVERLAP_MS },
      { propertyName: LAD_PROP, operator: "LTE", value: seed - 1 }]);
    expect(fresh.body.filterGroups[0].filters).toEqual([
      { propertyName: LAD_PROP, operator: "GTE", value: seed },
      { propertyName: LAD_PROP, operator: "LTE", value: NOW - SETTLE_MS }]);
    expect(fresh.body.sorts).toEqual([{ propertyName: "notes_last_updated", direction: "ASCENDING" }]);
    expect(fresh.body.limit).toBe(SEARCH_PAGE);
    expect([...new Set(hub.searches.map(x => x.object))]).toEqual(sweepOrder(NOW));
  });

  it("runs the ORDINARY, NON-FORCED sync for each record, then moves the watermark to the last one", async () => {
    hub.records.contacts = [{ id: "501", ts: at(1) }, { id: "502", ts: at(2) }];
    hub.records.companies = [{ id: "601", ts: at(3) }];
    hub.records.deals = [{ id: "701", ts: at(4) }];
    await sweepLastActivity(live, { nowMs: NOW });
    expect(synced()).toEqual(["501", "502", "601", "701"]);
    for (const c of sync.syncHubspotRecord.mock.calls) {
      expect(c).toHaveLength(5);                    // no ignoreItemId, no forceForward
      expect((c[3] as any).dryRun).toBe(false);
    }
    expect(store.wm.get(watermarkName("contacts"))).toBe(at(2));
    expect(store.wm.get(watermarkName("companies"))).toBe(at(3));
    expect(store.wm.get(watermarkName("deals"))).toBe(at(4));
  });

  it("is bounded: each object its share of the run's syncs, never more than MAX_PER_OBJECT", async () => {
    expect(sweepOrder(NOW)[0]).toBe("contacts");                 // the fixture's tick starts with Contacts
    hub.records.contacts = Array.from({ length: 25 }, (_, i) => ({ id: String(1000 + i), ts: at(i) }));
    const r = await sweepLastActivity(live, { nowMs: NOW });
    const share = Math.ceil(MAX_SYNCS_PER_RUN / 3);
    expect(r.objects.contacts?.cap).toBe(share);
    expect(synced("contacts")).toHaveLength(share);
    expect(r.objects.contacts?.stoppedBy).toBe("cap");
    expect(store.wm.get(watermarkName("contacts"))).toBe(at(share - 1));
  });

  it("an object going LAST gets what the others left, up to MAX_PER_OBJECT; the run's total is bounded", async () => {
    const lastTick = NOW + 15 * 60_000;                           // one tick on: companies, deals, contacts
    expect(sweepOrder(lastTick)).toEqual(["companies", "deals", "contacts"]);
    hub.records.contacts = Array.from({ length: 25 }, (_, i) => ({ id: String(1000 + i), ts: at(i) }));
    const quiet = await sweepLastActivity(live, { nowMs: lastTick });
    expect(quiet.objects.contacts?.cap).toBe(MAX_PER_OBJECT);    // nobody else needed theirs
    expect(synced("contacts")).toHaveLength(MAX_PER_OBJECT);

    vi.clearAllMocks(); store.wm.clear(); store.notes.clear();
    hub.records.deals = Array.from({ length: 25 }, (_, i) => ({ id: String(7000 + i), ts: at(i) }));
    const busy = await sweepLastActivity(live, { nowMs: lastTick });
    expect(synced()).toHaveLength(MAX_SYNCS_PER_RUN);              // the run's total, whoever spent it
    expect(busy.objects.deals!.synced + busy.objects.contacts!.synced).toBe(MAX_SYNCS_PER_RUN);
  });

  it("beside the marketing poll the run's total is lower", async () => {
    for (const o of ["contacts", "companies", "deals"])
      hub.records[o] = Array.from({ length: 25 }, (_, i) => ({ id: `${o}-${i}`, ts: at(i) }));
    await sweepLastActivity({ ...live, ENABLE_MARKETING_EMAIL_SYNC: "true" } as Env, { nowMs: NOW });
    expect(synced()).toHaveLength(MAX_SYNCS_WITH_MARKETING);
  });

  it("the start object rotates every tick, so each goes first one tick in three", () => {
    const firsts = [0, 1, 2].map(k => sweepOrder(NOW + k * 15 * 60_000)[0]);
    expect(new Set(firsts)).toEqual(new Set(["contacts", "companies", "deals"]));
  });

  /**
   * THE STALL THIS PREVENTS. Every run re-reads half an hour behind the watermark. Without remembering
   * what it already synced there, a busy half hour (more records than the cap) would be re-synced from
   * its start forever and the watermark would never move again.
   */
  it("keeps walking through a window denser than the cap: what it synced in the overlap is stepped over", async () => {
    hub.records.contacts = Array.from({ length: 25 }, (_, i) => ({ id: String(1000 + i), ts: at(i / 10) }));   // all within 3 min
    for (let i = 0; i < 25 / Math.ceil(MAX_SYNCS_PER_RUN / 3); i++) await sweepLastActivity(live, { nowMs: NOW });
    const ids = synced("contacts");
    expect(new Set(ids).size).toBe(25);             // every record once
    expect(ids).toHaveLength(25);                   // and not one twice
    expect(store.wm.get(watermarkName("contacts"))).toBe(at(2.4));
  });

  it("a record whose date moves AGAIN is synced again", async () => {
    hub.records.contacts = [{ id: "501", ts: at(1) }];
    await sweepLastActivity(live, { nowMs: NOW });
    hub.records.contacts = [{ id: "501", ts: at(5) }];
    await sweepLastActivity(live, { nowMs: NOW });
    expect(synced("contacts")).toEqual(["501", "501"]);
  });

  it("re-reads the overlap: a record indexed late, BEHIND the watermark, is still found", async () => {
    store.wm.set(watermarkName("contacts"), at(30));
    hub.records.contacts = [{ id: "900", ts: at(10) }];      // 20 min behind the watermark
    await sweepLastActivity(live, { nowMs: NOW });
    expect(synced("contacts")).toEqual(["900"]);
    expect(store.wm.get(watermarkName("contacts"))).toBe(at(30));   // never backwards
  });
});

/**
 * THE STALL (review 2026-09-30, reproduced three ways). The old sweep read ONE page of at most 100 rows
 * from 30 minutes behind the watermark. Once that overlap held ~100 rows it had already synced, every
 * row returned was a seen one, nothing new was reached, and the watermark never moved -- silently.
 */
describe("a dense burst never stalls the sweep", () => {
  const runs = async (n: number, nowMs = NOW) => { for (let i = 0; i < n; i++) await sweepLastActivity(live, { nowMs }); };

  it("150 contacts sharing ONE notes_last_updated (one activity on many contacts), then a later miss: all synced, the miss too", async () => {
    const burst = Array.from({ length: 150 }, (_, i) => ({ id: String(2000 + i), ts: at(0) }));
    hub.records.contacts = [...burst, { id: "9999", ts: at(60) }];
    await runs(40);
    const ids = synced("contacts");
    expect(new Set(ids).size).toBe(151);
    expect(ids).toHaveLength(151);                  // and not one twice
    expect(store.wm.get(watermarkName("contacts"))).toBe(at(60));
  });

  it("150 contacts within 5 minutes: every one synced exactly once, the watermark reaches the last", async () => {
    hub.records.contacts = Array.from({ length: 150 }, (_, i) => ({ id: String(3000 + i), ts: at(i / 30) }));
    await runs(40);
    const ids = synced("contacts");
    expect(new Set(ids).size).toBe(150);
    expect(ids).toHaveLength(150);
    expect(store.wm.get(watermarkName("contacts"))).toBe(at(149 / 30));
  });

  it("an overlap with more already-synced rows than its re-check reads cannot hold back the new work behind it", async () => {
    const W = at(30);
    store.wm.set(watermarkName("contacts"), W);
    const dense = Array.from({ length: 400 }, (_, i) => ({ id: String(4000 + i), ts: at(10 + i / 40) }));   // all behind W
    store.notes.set(seenName("contacts"), JSON.stringify({ seen: dense.map(r => [r.id, r.ts]), fail: null }));
    hub.records.contacts = [...dense, { id: "late", ts: at(29.5) }, { id: "new", ts: at(45) }];
    const r = await sweepLastActivity(live, { nowMs: NOW });
    expect(synced("contacts")).toEqual(["new"]);           // the late one is past the re-check's pages...
    expect(store.wm.get(watermarkName("contacts"))).toBe(at(45));   // ...but the watermark moves on
    expect(r.objects.contacts?.stoppedBy).toBeUndefined();
  });

  it(`more than ${NEW_PAGES} pages of already-synced rows AT the watermark's millisecond: it steps 1 ms past them, loudly`, async () => {
    const W = at(30);
    store.wm.set(watermarkName("contacts"), W);
    const tied = Array.from({ length: NEW_PAGES * SEARCH_PAGE + 50 }, (_, i) => ({ id: String(5000 + i), ts: W }));
    store.notes.set(seenName("contacts"), JSON.stringify({ seen: tied.map(r => [r.id, r.ts]), fail: null }));
    hub.records.contacts = [...tied, { id: "after", ts: at(40) }];
    const r = await sweepLastActivity(live, { nowMs: NOW });
    expect(r.objects.contacts?.tieSkipped).toBe(true);
    expect(store.wm.get(watermarkName("contacts"))).toBe(new Date(Date.parse(W) + 1).toISOString());
    await sweepLastActivity(live, { nowMs: NOW });
    expect(synced("contacts")).toEqual(["after"]);
  });
});

describe("the time budget is shared, so Deals are not starved", () => {
  it("each object gets its share of the deadline; unused time passes on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.parse("2026-09-30T12:00:00Z");
      vi.setSystemTime(t0);
      for (const o of ["contacts", "companies", "deals"])
        hub.records[o] = Array.from({ length: 25 }, (_, i) => ({ id: `${o}-${i}`, ts: at(i) }));
      sync.syncHubspotRecord.mockImplementation(async (_e: Env, spec: any, id: string) => {
        vi.setSystemTime(Date.now() + 60_000);             // one slow sync: a minute of monday rate waits
        return `${spec.object}/${id} ok`;
      });
      const r = await sweepLastActivity(live, { nowMs: NOW, deadlineMs: t0 + SWEEP_BUDGET_MS });
      expect(synced("deals").length).toBeGreaterThan(0);
      expect(r.objects.contacts?.stoppedBy).toBe("deadline");
    } finally { vi.useRealTimers(); }
  });

  it("sweepDeadline: its own budget, or what the cron has left, whichever comes first", () => {
    const t0 = Date.parse("2026-09-30T12:00:00Z");
    expect(sweepDeadline(t0, t0 + 60_000)).toBe(t0 + 60_000 + SWEEP_BUDGET_MS);
    expect(sweepDeadline(t0, t0 + 11 * 60_000)).toBe(t0 + SWEEP_LATEST_START_MS);
  });

  it("no time left: it takes nothing, not even the lock", async () => {
    hub.records.contacts = [{ id: "501", ts: at(1) }];
    const r = await sweepLastActivity(live, { nowMs: NOW, deadlineMs: Date.now() - 1 });
    expect(r.status).toBe("no-time");
    expect(store.acquireLock).not.toHaveBeenCalled();
    expect(hubspot.hs).not.toHaveBeenCalled();
  });
});

describe("it fails closed and stops where it failed", () => {
  it("an UNREADABLE watermark sweeps nothing -- never a silent restart from the seed", async () => {
    store.state.wmThrows = true;
    hub.records.contacts = [{ id: "501", ts: at(1) }];
    const r = await sweepLastActivity(live, { nowMs: NOW });
    expect(hubspot.hs).not.toHaveBeenCalled();
    expect(sync.syncHubspotRecord).not.toHaveBeenCalled();
    expect(store.setWatermark).not.toHaveBeenCalled();
    expect(r.objects.contacts?.error).toMatch(/unreadable/);
  });

  it("an unparseable watermark is refused the same way", async () => {
    store.wm.set(watermarkName("contacts"), "yesterday");
    hub.records.contacts = [{ id: "501", ts: at(1) }];
    await sweepLastActivity(live, { nowMs: NOW });
    expect(synced("contacts")).toEqual([]);
  });

  it("a failed sync stops that object at the last success; the others carry on", async () => {
    hub.records.contacts = [{ id: "501", ts: at(1) }, { id: "502", ts: at(2) }, { id: "503", ts: at(3) }];
    hub.records.companies = [{ id: "601", ts: at(1) }];
    sync.syncHubspotRecord.mockImplementation(async (_e: Env, spec: any, id: string) => {
      if (id === "502") throw new Error("monday 500");
      return `${spec.object}/${id} ok`;
    });
    const r = await sweepLastActivity(live, { nowMs: NOW });
    expect(synced("contacts")).toEqual(["501", "502"]);        // 503 never reached
    expect(r.objects.contacts?.stoppedBy).toBe("failure");
    expect(store.wm.get(watermarkName("contacts"))).toBe(at(1));
    expect(synced("companies")).toEqual(["601"]);
  });

  it(`a record that fails ${POISON_TRIES} times is stepped over, so it cannot hold its object forever`, async () => {
    hub.records.contacts = [{ id: "501", ts: at(1) }, { id: "502", ts: at(2) }];
    sync.syncHubspotRecord.mockImplementation(async (_e: Env, spec: any, id: string) => {
      if (id === "501") throw new Error("always");
      return `${spec.object}/${id} ok`;
    });
    const step = POISON_MIN_AGE_MS / (POISON_TRIES - 1);
    for (let i = 0; i < POISON_TRIES; i++) await sweepLastActivity(live, { nowMs: NOW + i * step });
    expect(synced("contacts").filter(id => id === "502")).toHaveLength(1);   // reached on the poison run
    expect(store.wm.get(watermarkName("contacts"))).toBe(at(2));
    expect(JSON.parse(store.notes.get(seenName("contacts"))!).fail).toBeNull();   // the clock is cleaned up
  });

  it(`${POISON_TRIES} failures in quick succession are NOT poison: the AGE is the clock`, async () => {
    hub.records.contacts = [{ id: "501", ts: at(1) }, { id: "502", ts: at(2) }];
    sync.syncHubspotRecord.mockImplementation(async (_e: Env, spec: any, id: string) => {
      if (id === "501") throw new Error("monday complexity budget");
      return `${spec.object}/${id} ok`;
    });
    // Four busy ticks, 45 minutes: a slow patch, not a dead record.
    for (let i = 0; i < POISON_TRIES + 1; i++) await sweepLastActivity(live, { nowMs: NOW + i * 15 * 60_000 });
    expect(synced("contacts")).not.toContain("502");
    expect(JSON.parse(store.notes.get(seenName("contacts"))!).fail).toMatchObject({ id: "501", n: POISON_TRIES + 1 });
    // It heals: the next success clears the clock.
    sync.syncHubspotRecord.mockImplementation(async (_e: Env, spec: any, id: string) => `${spec.object}/${id} ok`);
    await sweepLastActivity(live, { nowMs: NOW + 50 * 60_000 });
    expect(synced("contacts")).toContain("502");
    expect(JSON.parse(store.notes.get(seenName("contacts"))!).fail).toBeNull();
  });

  it("a watermark that cannot be saved is reported as a failure, not as progress", async () => {
    store.state.setThrows = true;
    hub.records.contacts = [{ id: "501", ts: at(1) }];
    const r = await sweepLastActivity(live, { nowMs: NOW });
    expect(r.objects.contacts?.error).toMatch(/not saved/);
    expect(r.objects.contacts?.watermark[1]).toBe(LAD_SWEEP_SEED);
  });

  it("past its deadline it starts nothing", async () => {
    hub.records.contacts = [{ id: "501", ts: at(1) }];
    await sweepLastActivity(live, { nowMs: NOW, deadlineMs: Date.now() - 1 });
    expect(sync.syncHubspotRecord).not.toHaveBeenCalled();
  });

  it("another sweep holding the lock (or no lock store) means this one does nothing", async () => {
    store.state.lockFree = false;
    hub.records.contacts = [{ id: "501", ts: at(1) }];
    const r = await sweepLastActivity(live, { nowMs: NOW });
    expect(r.status).toBe("busy");
    expect(hubspot.hs).not.toHaveBeenCalled();
  });

  it("a store blip reading the seen set costs only a repeat sync, and the lock is still released", async () => {
    store.readNote.mockRejectedValueOnce(new Error("store down"));   // readSeen reads it as empty
    hub.records.contacts = [{ id: "501", ts: at(1) }];
    await sweepLastActivity(live, { nowMs: NOW });
    expect(store.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe("the write budget", () => {
  it("is per object: a Contacts run that spends it all does not starve Accounts and Deals", async () => {
    hub.records.contacts = Array.from({ length: 5 }, (_, i) => ({ id: String(100 + i), ts: at(i) }));
    hub.records.companies = [{ id: "601", ts: at(1) }];
    sync.syncHubspotRecord.mockImplementation(async (_e: Env, _s: any, _i: string, _o: any, b: any) => { b.left -= 2; return "ok"; });
    const r = await sweepLastActivity({ ...live, MAX_WRITES: "4" } as Env, { nowMs: NOW });
    expect(r.objects.contacts?.stoppedBy).toBe("budget");
    expect(synced("contacts")).toHaveLength(2);
    expect(synced("companies")).toEqual(["601"]);
  });
});

describe("a dry run", () => {
  it("syncs with writes suppressed and moves NO cursor (it would hide real work from the next live run)", async () => {
    hub.records.contacts = [{ id: "501", ts: at(1) }];
    await sweepLastActivity({ ...live, DRY_RUN: "true" } as Env, { nowMs: NOW });
    expect((sync.syncHubspotRecord.mock.calls[0][3] as any).dryRun).toBe(true);
    expect(store.setWatermark).not.toHaveBeenCalled();
    expect(store.writeNote).not.toHaveBeenCalled();
    expect(store.acquireLock).not.toHaveBeenCalled();
  });
});

describe("deals", () => {
  it("are skipped where deals route across boards (the Work Management shape)", async () => {
    sync.legacyDealRouting.mockReturnValue(true);
    hub.records.deals = [{ id: "701", ts: at(1) }];
    const r = await sweepLastActivity(live, { nowMs: NOW });
    expect(synced("deals")).toEqual([]);
    expect(r.objects.deals?.skipped).toBeTruthy();
  });
});

describe("structurally", () => {
  it("never passes forceForward, and never writes HubSpot itself", () => {
    const code = readCode("lad-sweep.ts");
    expect(code).not.toMatch(/forceForward|patchRecord|createRecord/);
    expect(code).toMatch(/syncHubspotRecord\(env, spec, row\.id, runOpts, budget\)/);
    expect(code).not.toMatch(/"(PATCH|PUT|DELETE)"/);
  });
});
